import './global.css';

export const metadata = {
  title: 'Agent eval',
  description: 'Runs, traces and metrics of the personal agent harness.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <strong>Agent eval</strong>
          <a href="/">Threads</a>
          <a href="/usage">Usage</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
