import './global.css';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import { Providers } from '@/components/providers';
import {
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
} from '@/lib/theme-presets';

const sans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-ui',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-code',
  display: 'swap',
  weight: ['400', '500'],
});

export const metadata = {
  title: 'Desk',
  description: 'Home and workspace agent',
};

/**
 * FOUC guard: restore theme before paint.
 * Migrates legacy theme ids; toggles .dark / .light for Streamdown/Shiki.
 */
const themeInitScript = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var d=${JSON.stringify(DEFAULT_THEME_ID)};var legacy={ink:'studio',signal:'studio',glacier:'midnight',moss:'midnight',lamp:'ember'};var t=localStorage.getItem(k)||d;if(legacy[t])t=legacy[t];var ok={studio:1,midnight:1,ember:1,paper:1};if(!ok[t])t=d;var light=t==='paper';document.documentElement.setAttribute('data-theme',t);document.documentElement.classList.toggle('dark',!light);document.documentElement.classList.toggle('light',light);document.documentElement.style.colorScheme=light?'light':'dark';}catch(e){document.documentElement.setAttribute('data-theme',${JSON.stringify(DEFAULT_THEME_ID)});document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
