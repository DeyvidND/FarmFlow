import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'ff-btn inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-[14.5px] font-bold transition-[transform,background,box-shadow] duration-150 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 active:translate-y-0 hover:-translate-y-px',
  {
    variants: {
      variant: {
        // primary green — the ФермериБГ brand button
        primary: 'bg-ff-green-700 text-white shadow-[0_2px_6px_rgba(40,35,20,0.14)] hover:brightness-[1.03]',
        amber: 'bg-ff-amber text-[#3a2a08] shadow-[0_2px_6px_rgba(40,35,20,0.14)] hover:brightness-[1.03]',
        ghost: 'bg-ff-surface text-ff-ink border border-ff-border shadow-ff-sm',
        outline: 'bg-ff-surface text-ff-green-700 border-[1.5px] border-ff-green-600',
        soft: 'bg-ff-green-100 text-ff-green-800',
        danger: 'bg-ff-surface-2 text-ff-ink-2 border border-ff-border',
      },
      size: {
        default: 'px-4 py-2.5',
        sm: 'px-3 py-2 text-[13px]',
        lg: 'px-4 py-3 text-[15.5px]',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
