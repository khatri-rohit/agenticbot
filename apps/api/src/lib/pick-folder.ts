import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PickFolderResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'error'; message: string };

let picking: Promise<PickFolderResult> | null = null;

/**
 * Open the OS folder picker on the API host (same machine that runs tools).
 */
export function pickFolderDialog(
  initialDir?: string,
): Promise<PickFolderResult> {
  if (picking) return picking;
  picking = runPicker(initialDir).finally(() => {
    picking = null;
  });
  return picking;
}

async function runPicker(initialDir?: string): Promise<PickFolderResult> {
  try {
    if (process.platform === 'win32') {
      return await pickWindows(initialDir);
    }
    if (process.platform === 'darwin') {
      return await pickMac();
    }
    return await pickLinux();
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Prefer Shell.Application BrowseForFolder (desktop-owned, reliable from Node),
 * then fall back to WinForms with an explicit topmost owner form.
 */
async function pickWindows(initialDir?: string): Promise<PickFolderResult> {
  const shellResult = await runPowerShellFile(buildShellBrowseScript());
  if (shellResult.ok || shellResult.reason === 'cancelled') {
    return shellResult;
  }
  return runPowerShellFile(buildWinFormsScript(initialDir));
}

function buildShellBrowseScript(): string {
  // hwnd=0 attaches to the desktop so the dialog is visible even when Node
  // has no UI window. Exit 2 = cancelled.
  return `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder(0, 'Select a project folder', 0)
if ($null -eq $folder) { exit 2 }
$path = $folder.Self.Path
if (-not $path) { exit 2 }
[Console]::Out.Write($path)
exit 0
`.trim();
}

function buildWinFormsScript(initialDir?: string): string {
  // Literal here-string — path is written as-is (no PowerShell expansion).
  const initialBlock = initialDir
    ? `$dialog.SelectedPath = @'\n${initialDir}\n'@`
    : '';
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Location = New-Object System.Drawing.Point(-3000, -3000)
$owner.Size = New-Object System.Drawing.Size(1, 1)
[void]$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a project folder'
$dialog.ShowNewFolderButton = $true
${initialBlock}
try {
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
    [Console]::Out.Write($dialog.SelectedPath)
    exit 0
  }
  exit 2
} finally {
  $owner.Close()
  $owner.Dispose()
}
`.trim();
}

async function runPowerShellFile(script: string): Promise<PickFolderResult> {
  const scriptPath = path.join(
    tmpdir(),
    `agenticbot-pick-${randomUUID()}.ps1`,
  );
  await writeFile(scriptPath, `\uFEFF${script}\n`, 'utf8');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ],
      {
        // Must stay visible — windowsHide:true suppresses BrowseForFolder /
        // FolderBrowserDialog on many Windows hosts (dialog never appears).
        windowsHide: false,
        maxBuffer: 1024 * 1024,
        timeout: 10 * 60 * 1000,
      },
    );
    const selected = stdout.trim();
    if (!selected) {
      return { ok: false, reason: 'cancelled' };
    }
    return { ok: true, path: selected };
  } catch (error) {
    const err = error as ExecFileException & {
      stdout?: string;
      stderr?: string;
    };
    if (err.code === 2) {
      return { ok: false, reason: 'cancelled' };
    }
    const detail = [err.stderr, err.message].filter(Boolean).join(' — ');
    return {
      ok: false,
      reason: 'error',
      message: detail || 'Folder picker failed',
    };
  } finally {
    await unlink(scriptPath).catch(() => undefined);
  }
}

async function pickMac(): Promise<PickFolderResult> {
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "Select a project folder")',
    ]);
    const selected = stdout.trim().replace(/\/$/, '');
    if (!selected) return { ok: false, reason: 'cancelled' };
    return { ok: true, path: selected };
  } catch (error) {
    const err = error as ExecFileException & { stderr?: string };
    const detail = `${err.stderr ?? ''} ${err.message ?? ''}`.toLowerCase();
    const cancelled =
      detail.includes('-128') ||
      detail.includes('user canceled') ||
      detail.includes('user cancelled');
    if (cancelled) {
      return { ok: false, reason: 'cancelled' };
    }
    return {
      ok: false,
      reason: 'error',
      message: err.message || 'Folder picker failed',
    };
  }
}

async function pickLinux(): Promise<PickFolderResult> {
  const tools: Array<{ bin: string; args: string[] }> = [
    {
      bin: 'zenity',
      args: [
        '--file-selection',
        '--directory',
        '--title=Select a project folder',
      ],
    },
    { bin: 'kdialog', args: ['--getexistingdirectory'] },
  ];
  let lastError = 'No folder dialog tool found (install zenity or kdialog)';
  for (const tool of tools) {
    try {
      const { stdout } = await execFileAsync(tool.bin, tool.args);
      const selected = stdout.trim();
      if (!selected) return { ok: false, reason: 'cancelled' };
      return { ok: true, path: selected };
    } catch (error) {
      const err = error as ExecFileException;
      if (err.code === 1) return { ok: false, reason: 'cancelled' };
      lastError = err.message || lastError;
    }
  }
  return { ok: false, reason: 'error', message: lastError };
}
