import './global.css';

export const metadata = {
  title: 'AgenticBot',
  description: 'Local-first AI agent with streaming chat',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}