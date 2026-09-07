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
        <div className="toast-container" role="status" aria-live="polite">
          <div className="toast" key={toast.id}>{toast.text}</div>
        </div>
      )}
    </ToastContext.Provider>
  );
}
