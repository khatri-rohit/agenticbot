import './global.css';
import { Providers } from '@/components/providers';

export const metadata = {
  title: 'AgenticBot',
  description: 'Research agent',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
