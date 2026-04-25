import { useState, useEffect, useCallback, createContext, useContext } from 'react';

type ToastFn = (text: string) => void;

const ToastContext = createContext<ToastFn>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);

  const show: ToastFn = useCallback((text: string) => {
    setToast({ text, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className="toast" key={toast.id}>
          <div className="toast-title">Copied to clipboard.</div>
          <pre className="toast-text">{toast.text}</pre>
        </div>
      )}
    </ToastContext.Provider>
  );
}
