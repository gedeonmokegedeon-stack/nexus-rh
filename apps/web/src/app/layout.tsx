import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth-context';

export const metadata: Metadata = {
  title: 'NEXUS RH — Plateforme SaaS RH, Présences Biométriques & Paie RDC',
  description:
    'Plateforme SaaS multi-entreprises et multi-sites de gestion des ressources humaines, des présences biométriques multi-marques et de la paie paramétrable.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
