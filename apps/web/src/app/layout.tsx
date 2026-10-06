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
      <body className="bg-zinc-950 text-zinc-200">{children}</body>
    </html>
  );
}