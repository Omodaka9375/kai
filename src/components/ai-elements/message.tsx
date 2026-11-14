"use client";

import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { ChatStreamingProvider } from "./chat-code";
import { ChatTable } from "./chat-table";
import { MarkdownCode } from "./markdown-code";
// ChatFileLink lives in modules/ai (composition layer) — registry components
// don't import app code, and the link's open-file routing is app business.
import { ChatFileLink } from "@/modules/ai/components/ChatFileLink";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user"
        ? "is-user ml-auto max-w-[85%] items-end justify-end"
        : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden overflow-wrap-anywhere text-[12px] leading-relaxed",
      "group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-sm group-[.is-user]:bg-muted/70 group-[.is-user]:px-3 group-[.is-user]:py-2 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:w-full group-[.is-assistant]:max-w-full group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null,
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch",
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange],
  );

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious],
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children],
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden",
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className,
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <HugeiconsIcon icon={ArrowRight01Icon} size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className,
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  streaming?: boolean;
};

const streamdownComponents = {
  code: MarkdownCode,
  table: ChatTable,
  a: ChatFileLink,
};

/**
 * Disable table download — blob-URL anchor clicks don't trigger downloads
 * in Tauri's webview. Copy and fullscreen still work.
 */
const streamdownControls = {
  table: { download: false },
};

export const MessageResponse = memo(
  ({ className, streaming = false, ...props }: MessageResponseProps) => (
    <ChatStreamingProvider value={streaming}>
      <Streamdown
        className={cn(
          "size-full min-w-0 max-w-full overflow-wrap-anywhere [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_blockquote]:max-w-full [&_p]:max-w-full [&_pre]:max-w-full",
          // CHAT-SCALE TYPOGRAPHY (2026-11-14): Streamdown's element defaults
          // are doc-scale - h2 = text-2xl (24px), h1 = text-3xl - grotesque
          // against the 12px chat body. And strong gets ONLY font-semibold,
          // so agents that write **bold lead-ins** instead of # headings
          // produced a flat wall: same size, same color, weight the sole
          // signal. Two layers fix both: (1) a chat heading scale, semibold,
          // full foreground, tightened margins; (2) body text (p/li) dimmed
          // one step to foreground/85 so bold lead-ins, strong and headings
          // pop BY CONTRAST - hierarchy survives even when the agent never
          // emits a heading. The arbitrary-variant selectors outrank
          // Streamdown's own utility classes (0,1,1 vs 0,1,0).
          "[&_h1]:mt-4 [&_h1]:mb-1.5 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:leading-snug [&_h1]:text-foreground",
          "[&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:leading-snug [&_h2]:text-foreground",
          "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:leading-snug [&_h3]:text-foreground",
          "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-xs [&_h4]:font-semibold [&_h4]:text-foreground",
          "[&_h5]:mt-3 [&_h5]:mb-1 [&_h5]:text-xs [&_h5]:font-semibold [&_h5]:text-foreground",
          "[&_h6]:mt-3 [&_h6]:mb-1 [&_h6]:text-xs [&_h6]:font-semibold [&_h6]:text-foreground",
          "[&_strong]:text-foreground [&_b]:text-foreground",
          "[&_p]:text-foreground/85 [&_li]:text-foreground/85",
          "[&_hr]:my-3 [&_hr]:border-border/60",
          className,
        )}
        linkSafety={{ enabled: false }}
        skipHtml
        components={streamdownComponents}
        controls={streamdownControls}
        {...props}
      />
    </ChatStreamingProvider>
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.streaming === nextProps.streaming &&
    nextProps.isAnimating === prevProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);
