import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

interface HeaderProps {
  title: string;
  showBack?: boolean;
  rightAction?: React.ReactNode;
  className?: string;
}

export function Header({ title, showBack = false, rightAction, className }: HeaderProps) {
  const navigate = useNavigate();

  return (
    <header
      className={cn('sticky top-0 z-30 border-b bg-background/95 backdrop-blur px-4', className)}
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex h-14 items-center">
        <div className="flex items-center gap-3 flex-1">
          {showBack && (
            <button
              onClick={() => {
                // A directly-loaded/deep-linked page has no prior entry to go back
                // to, in which case navigate(-1) is a silent no-op.
                if (window.history.length > 1) {
                  navigate(-1);
                } else {
                  navigate('/dashboard');
                }
              }}
              className="rounded-md p-1 hover:bg-accent"
              aria-label="Go back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <h1 className="text-lg font-semibold truncate">{title}</h1>
        </div>
        {rightAction && <div>{rightAction}</div>}
      </div>
    </header>
  );
}
