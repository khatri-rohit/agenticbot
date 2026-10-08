import './global.css';
import { Providers } from '@/components/providers';
import { DEFAULT_THEME_ID, THEME_STORAGE_KEY } from '@/lib/theme-presets';

export const metadata = {
  title: 'AgenticBot',
  description: 'Research agent',
};

const themeInitScript = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var d=${JSON.stringify(DEFAULT_THEME_ID)};var t=localStorage.getItem(k);document.documentElement.setAttribute('data-theme',t||d);document.documentElement.classList.add('dark');}catch(e){document.documentElement.setAttribute('data-theme',${JSON.stringify(DEFAULT_THEME_ID)});document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
