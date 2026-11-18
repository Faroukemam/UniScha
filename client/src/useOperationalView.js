import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export default function useOperationalView(fetcher, initial) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    api.clearCache(); setLoading(true); setError('');
    try { const value = await fetcher(); if (id === sequence.current) setData(value); }
    catch (failure) { if (id === sequence.current) setError(failure.message); }
    finally { if (id === sequence.current) setLoading(false); }
  }, [fetcher]);
  useEffect(() => {
    refresh();
    window.addEventListener('scheduler:data-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => { sequence.current += 1; window.removeEventListener('scheduler:data-changed', refresh); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  return { data, loading, error, refresh };
}
