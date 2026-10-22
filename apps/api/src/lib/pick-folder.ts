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
 * Open a native folder picker on the API host (same machine that runs tools).
 * Windows uses modern IFileOpenDialog (Explorer-style), not BrowseForFolder.
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
      return await runPowerShellFile(
        buildWindowsModernFolderScript(initialDir),
      );
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

/** C# helper compiled via Add-Type — Vista+ folder picker UI. */
const WINDOWS_FOLDER_PICKER_CS = `
using System;
using System.Runtime.InteropServices;

public static class AgentFolderPicker {
  [ComImport]
  [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
  class FileOpenDialogRCW { }

  [ComImport]
  [Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }

  [ComImport]
  [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(
    [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
    IntPtr pbc,
    ref Guid riid,
    [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

  const uint FOS_PICKFOLDERS = 0x00000020;
  const uint FOS_FORCEFILESYSTEM = 0x00000040;
  const uint SIGDN_FILESYSPATH = 0x80058000;
  const int S_OK = 0;

  public static string Pick(string title, string initialDir) {
    var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
    dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
    if (!string.IsNullOrWhiteSpace(title)) {
      dialog.SetTitle(title);
    }
    if (!string.IsNullOrWhiteSpace(initialDir)) {
      try {
        var iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        IShellItem item;
        SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref iid, out item);
        dialog.SetFolder(item);
      } catch {
      }
    }
    if (dialog.Show(IntPtr.Zero) != S_OK) {
      return null;
    }
    IShellItem result;
    dialog.GetResult(out result);
    string path;
    result.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return path;
  }
}
`.trim();

function buildWindowsModernFolderScript(initialDir?: string): string {
  // Single-quoted PowerShell string — escape embedded single quotes.
  const initial = (initialDir ?? '').replace(/'/g, "''");
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -TypeDefinition @'`,
    WINDOWS_FOLDER_PICKER_CS,
    `'@`,
    `$path = [AgentFolderPicker]::Pick('Select a project folder', '${initial}')`,
    `if ([string]::IsNullOrWhiteSpace($path)) { exit 2 }`,
    `[Console]::Out.Write($path.Trim())`,
    `exit 0`,
  ].join('\n');
}

async function runPowerShellFile(script: string): Promise<PickFolderResult> {
  const scriptPath = path.join(tmpdir(), `agent-pick-${randomUUID()}.ps1`);
  await writeFile(scriptPath, `\uFEFF${script}\n`, 'utf8');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        // Must stay visible — windowsHide suppresses the folder dialog.
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
    const err = error as ExecFileException;
    if (typeof err.code === 'number' && err.code !== 0) {
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
