/**
 * Policy Layer Enhancement
 * Tool action classifier and enhanced shell command analysis
 */

import { checkShellCommand } from "./security";

/**
 * Tool action categories for policy enforcement
 */
export type ToolActionCategory =
  | "read"
  | "write"
  | "execute"
  | "modify"
  | "create"
  | "delete"
  | "network"
  | "system";

export type ToolActionInfo = {
  category: ToolActionCategory;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiresApproval: boolean;
  description: string;
};

/**
 * Classify tool actions by risk and category
 */
export const TOOL_ACTION_CLASSIFIER: Record<string, ToolActionInfo> = {
  // Read operations - low risk
  read_file: {
    category: "read",
    riskLevel: "low",
    requiresApproval: false,
    description: "Read file contents",
  },
  list_directory: {
    category: "read",
    riskLevel: "low",
    requiresApproval: false,
    description: "List directory contents",
  },
  grep: {
    category: "read",
    riskLevel: "low",
    requiresApproval: false,
    description: "Search file contents",
  },
  glob: {
    category: "read",
    riskLevel: "low",
    requiresApproval: false,
    description: "Find files by pattern",
  },

  // Write operations - medium risk
  write_file: {
    category: "write",
    riskLevel: "medium",
    requiresApproval: true,
    description: "Create or overwrite file",
  },
  edit: {
    category: "modify",
    riskLevel: "medium",
    requiresApproval: true,
    description: "Modify file contents",
  },
  multi_edit: {
    category: "modify",
    riskLevel: "medium",
    requiresApproval: true,
    description: "Apply multiple file modifications",
  },

  // Create operations - medium risk
  create_directory: {
    category: "create",
    riskLevel: "medium",
    requiresApproval: true,
    description: "Create directory",
  },

  // Delete operations - high risk
  delete_file: {
    category: "delete",
    riskLevel: "high",
    requiresApproval: true,
    description: "Delete file",
  },
  delete_directory: {
    category: "delete",
    riskLevel: "high",
    requiresApproval: true,
    description: "Delete directory",
  },

  // Execute operations - high risk
  bash_run: {
    category: "execute",
    riskLevel: "high",
    requiresApproval: true,
    description: "Execute shell command",
  },
  bash_background: {
    category: "execute",
    riskLevel: "high",
    requiresApproval: true,
    description: "Spawn background process",
  },

  // Network operations - medium risk
  web_fetch: {
    category: "network",
    riskLevel: "medium",
    requiresApproval: false,
    description: "Fetch web content",
  },
  web_search: {
    category: "network",
    riskLevel: "low",
    requiresApproval: false,
    description: "Search the web",
  },

  // System operations - critical risk
  shell_session_run: {
    category: "system",
    riskLevel: "critical",
    requiresApproval: true,
    description: "Run persistent shell session",
  },
};

/**
 * Get action info for a tool
 */
export function getToolActionInfo(toolName: string): ToolActionInfo {
  return TOOL_ACTION_CLASSIFIER[toolName] ?? {
    category: "execute",
    riskLevel: "medium",
    requiresApproval: true,
    description: `Execute ${toolName}`,
  };
}

/**
 * Enhanced shell command analysis
 * Adds structural analysis to the basic security checks
 */
export type ShellCommandAnalysis = {
  safe: boolean;
  riskLevel: "low" | "medium" | "high" | "critical";
  warnings: string[];
  suggestions: string[];
};

/**
 * Analyze shell command for safety and best practices
 */
export function analyzeShellCommand(cmd: string): ShellCommandAnalysis {
  const warnings: string[] = [];
  const suggestions: string[] = [];
  let riskLevel: ShellCommandAnalysis["riskLevel"] = "low";

  // First run the basic security check
  const safety = checkShellCommand(cmd);
  if (!safety.ok) {
    return {
      safe: false,
      riskLevel: "critical",
      warnings: [safety.reason],
      suggestions: ["This command is blocked for safety reasons"],
    };
  }

  // Analyze command structure
  const normalized = cmd.trim().toLowerCase();

  // Check for destructive patterns
  if (/\brm\s+-rf\b/.test(normalized)) {
    warnings.push("Recursive force delete detected - verify target path");
    riskLevel = "high";
    suggestions.push("Consider using --interactive flag for safety");
  }

  // Check for sudo usage
  if (/\bsudo\b/.test(normalized)) {
    warnings.push("Command uses sudo - elevated privileges required");
    riskLevel = "high";
    suggestions.push("Verify you need elevated privileges for this operation");
  }

  // Check for chown/chmod
  if (/\b(chown|chmod)\b/.test(normalized)) {
    warnings.push("Permission modification detected");
    riskLevel = "medium";
    suggestions.push("Verify target files and permission values");
  }

  // Check for curl/wget piped to shell (already blocked by security.ts, but warn)
  if (/\b(curl|wget)\b/.test(normalized) && /\|/.test(normalized)) {
    warnings.push("Network download piped to shell - potential security risk");
    riskLevel = "high";
    suggestions.push("Download file first, inspect it, then execute");
  }

  // Check for interactive commands
  const interactiveCommands = ["vim", "nano", "less", "more", "top", "htop"];
  for (const interactive of interactiveCommands) {
    if (new RegExp(`\\b${interactive}\\b`).test(normalized)) {
      warnings.push(`Interactive command detected: ${interactive}`);
      riskLevel = "medium";
      suggestions.push("Consider using non-interactive alternatives");
    }
  }

  // Check for background processes
  if (normalized.endsWith("&") || /\bnohup\b/.test(normalized)) {
    warnings.push("Background process detected");
    riskLevel = "medium";
    suggestions.push("Consider using bash_background tool for better process management");
  }

  // Check for process substitution
  if (/<\(/.test(normalized) || />/.test(normalized)) {
    warnings.push("Process substitution detected");
    riskLevel = "medium";
    suggestions.push("Verify the command logic is correct");
  }

  // Check for eval
  if (/\beval\b/.test(normalized)) {
    warnings.push("Eval command detected - code execution risk");
    riskLevel = "high";
    suggestions.push("Avoid eval when possible - it can execute arbitrary code");
  }

  // Check for command substitution
  if (/\$\(/.test(normalized) || /\`/.test(normalized)) {
    warnings.push("Command substitution detected");
    riskLevel = "medium";
    suggestions.push("Verify substituted commands are safe");
  }

  // Check for environment variable manipulation
  if (/\bexport\b/.test(normalized)) {
    warnings.push("Environment variable modification detected");
    riskLevel = "low";
    suggestions.push("Verify environment changes are intentional");
  }

  // Check for package manager operations
  if (/\b(pnpm|npm|yarn|bun)\s+(install|uninstall|remove|add)/.test(normalized)) {
    warnings.push("Package manager operation detected");
    riskLevel = "medium";
    suggestions.push("Verify package names and versions before proceeding");
  }

  // Check for git operations
  if (/\bgit\s+(push|reset|rebase|checkout)\b/.test(normalized)) {
    warnings.push("Git operation with potential side effects detected");
    riskLevel = "medium";
    suggestions.push("Verify the git operation is correct before executing");
  }

  // Check for database operations
  if (/\b(mysql|psql|mongo|redis-cli)\b/.test(normalized)) {
    warnings.push("Database operation detected");
    riskLevel = "high";
    suggestions.push("Verify database command and target connection");
  }

  // Check for file operations on sensitive locations
  const sensitivePaths = ["/etc/", "/var/log/", "/tmp/", "~/"];
  for (const sensitive of sensitivePaths) {
    if (normalized.includes(sensitive)) {
      warnings.push(`Access to sensitive path: ${sensitive}`);
      riskLevel = "medium";
      suggestions.push("Verify the target path is correct");
    }
  }

  return {
    safe: warnings.length === 0,
    riskLevel,
    warnings,
    suggestions,
  };
}

/**
 * Get risk level description
 */
export function getRiskLevelDescription(level: ToolActionInfo["riskLevel"]): string {
  switch (level) {
    case "low":
      return "Low risk - generally safe to execute";
    case "medium":
      return "Medium risk - requires user approval";
    case "high":
      return "High risk - careful review recommended";
    case "critical":
      return "Critical risk - blocked or requires explicit confirmation";
  }
}

/**
 * Check if a tool requires approval based on policy
 */
export function requiresApproval(toolName: string): boolean {
  return getToolActionInfo(toolName).requiresApproval;
}

/**
 * Get policy summary for UI display
 */
export function getPolicySummary(): {
  totalTools: number;
  approvalRequired: number;
  riskLevels: Record<string, number>;
} {
  const totalTools = Object.keys(TOOL_ACTION_CLASSIFIER).length;
  let approvalRequired = 0;
  const riskLevels: Record<string, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  for (const info of Object.values(TOOL_ACTION_CLASSIFIER)) {
    if (info.requiresApproval) approvalRequired++;
    riskLevels[info.riskLevel]++;
  }

  return {
    totalTools,
    approvalRequired,
    riskLevels,
  };
}
