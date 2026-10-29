import { createContext, useContext, type ReactNode } from "react";

const FileMenuTriggerContext = createContext<ReactNode>(null);

export const FileMenuTriggerProvider = FileMenuTriggerContext.Provider;

export function useFileMenuTrigger(): ReactNode {
  return useContext(FileMenuTriggerContext);
}
