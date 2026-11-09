import './global.css';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Providers } from '@/components/shell/providers';
import { THEME_INIT_SCRIPT } from '@/components/shell/theme-presets';

// Inter: a reading face for long replies. Plus Jakarta (display) read as
// marketing copy at body sizes.
const sans = Inter({
  subsets: ['latin'],
  variable: '--font-ui',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-code',
  display: 'swap',
  weight: ['400', '500'],
});

export const metadata = {
  title: 'Personal Assistant',
  description: 'Home and workspace agent',
};

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
        {/* FOUC guard: sets html.dark/.light before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
