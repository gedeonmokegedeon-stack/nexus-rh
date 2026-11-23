'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

export default function HomePage() {
  const router = useRouter();
  const { loading, needsInitialSetup, me } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (needsInitialSetup) {
      router.replace('/setup');
    } else if (me) {
      router.replace('/dashboard');
    } else {
      router.replace('/login');
    }
  }, [loading, needsInitialSetup, me, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0B1628] text-slate-200">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-400" />
        <p className="text-sm font-medium tracking-wide">Chargement sécurisé de NEXUS RH…</p>
      </div>
    </div>
  );
}
