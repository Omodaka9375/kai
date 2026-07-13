/**
 * Stack Detection System
 * Auto-detects project tech stack from package.json, tsconfig, and config files
 * 
 * Note: Uses native Tauri commands for file operations to work in browser environment.
 */

import { native } from "../lib/native";

export type DetectedFramework =
  | "react"
  | "nextjs"
  | "vue"
  | "svelte"
  | "solid"
  | "express"
  | "fastify"
  | "hono"
  | "nest"
  | "drizzle"
  | "prisma"
  | "typeorm"
  | "bullmq"
  | "redis"
  | "tailwind"
  | "chakra"
  | "mui"
  | "shadcn"
  | "vitest"
  | "jest"
  | "playwright"
  | "cypress"
  | "testing-library";

export type StackInfo = {
  frameworks: DetectedFramework[];
  packageManager: "pnpm" | "npm" | "yarn" | "bun";
  hasTypeScript: boolean;
  hasVite: boolean;
  hasNextJs: boolean;
  hasReact: boolean;
  hasVue: boolean;
  hasSvelte: boolean;
  hasDrizzle: boolean;
  hasPrisma: boolean;
  hasBullMQ: boolean;
  hasTailwind: boolean;
};

export type RulePack = {
  name: string;
  description: string;
  priority: "high" | "medium" | "low";
  rules: string[];
};

/**
 * Join path segments (cross-platform, handles both / and \)
 */
function joinPath(...parts: string[]): string {
  return parts
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
}

/**
 * Detect stack from package.json and related files
 */
export async function detectStack(projectPath: string): Promise<StackInfo> {
  const frameworks: DetectedFramework[] = [];
  let packageManager: StackInfo["packageManager"] = "pnpm";

  try {
    // Detect package manager using native readDir
    const files = await native.readDir(projectPath);
    const fileNames = files.map((e) => e.name);
    
    if (fileNames.includes("pnpm-lock.yaml")) packageManager = "pnpm";
    else if (fileNames.includes("yarn.lock")) packageManager = "yarn";
    else if (fileNames.includes("bun.lockb") || fileNames.includes("bun.lock")) packageManager = "bun";
    else if (fileNames.includes("package-lock.json")) packageManager = "npm";

    // Read package.json using native readFile
    const pkgPath = joinPath(projectPath, "package.json");
    const pkgResult = await native.readFile(pkgPath);
    
    if (pkgResult.kind !== "text") {
      throw new Error("package.json is not a text file");
    }
    
    const pkg = JSON.parse(pkgResult.content);

    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    // Detect frameworks based on dependencies
    if (deps["react"]) frameworks.push("react");
    if (deps["next"]) frameworks.push("nextjs");
    if (deps["vue"]) frameworks.push("vue");
    if (deps["svelte"]) frameworks.push("svelte");
    if (deps["solid-js"]) frameworks.push("solid");
    if (deps["express"]) frameworks.push("express");
    if (deps["fastify"]) frameworks.push("fastify");
    if (deps["hono"]) frameworks.push("hono");
    if (deps["@nestjs/core"]) frameworks.push("nest");
    if (deps["drizzle-orm"]) frameworks.push("drizzle");
    if (deps["prisma"]) frameworks.push("prisma");
    if (deps["typeorm"]) frameworks.push("typeorm");
    if (deps["bullmq"]) frameworks.push("bullmq");
    if (deps["redis"]) frameworks.push("redis");
    if (deps["tailwindcss"]) frameworks.push("tailwind");
    if (deps["@chakra-ui/react"]) frameworks.push("chakra");
    if (deps["@mui/material"]) frameworks.push("mui");
    if (pkg.dependencies?.shadcn || pkg.devDependencies?.shadcn) frameworks.push("shadcn");

    // Test frameworks
    if (deps.vitest) frameworks.push("vitest");
    if (deps.jest) frameworks.push("jest");
    if (deps.playwright) frameworks.push("playwright");
    if (deps.cypress) frameworks.push("cypress");
    if (deps["@testing-library/react"]) frameworks.push("testing-library");

    const hasTypeScript = !!deps.typescript || !!pkg.scripts?.typecheck;
    const hasVite = !!deps.vite;
    const hasNextJs = !!deps.next;
    const hasReact = !!deps.react;
    const hasVue = !!deps.vue;
    const hasSvelte = !!deps.svelte;
    const hasDrizzle = !!deps["drizzle-orm"];
    const hasPrisma = !!deps.prisma;
    const hasBullMQ = !!deps.bullmq;
    const hasTailwind = !!deps.tailwindcss;

    return {
      frameworks: [...new Set(frameworks)],
      packageManager,
      hasTypeScript,
      hasVite,
      hasNextJs,
      hasReact,
      hasVue,
      hasSvelte,
      hasDrizzle,
      hasPrisma,
      hasBullMQ,
      hasTailwind,
    };
  } catch {
    // Default stack info if detection fails
    return {
      frameworks: [],
      packageManager: "pnpm",
      hasTypeScript: true,
      hasVite: false,
      hasNextJs: false,
      hasReact: false,
      hasVue: false,
      hasSvelte: false,
      hasDrizzle: false,
      hasPrisma: false,
      hasBullMQ: false,
      hasTailwind: false,
    };
  }
}

/**
 * Get recommended rule packs based on detected stack
 */
export function getRulePacksForStack(stack: StackInfo): RulePack[] {
  const packs: RulePack[] = [];

  // Always include safety pack
  packs.push({
    name: "safety",
    description: "Core safety rules for TypeScript",
    priority: "high",
    rules: [
      "typescript-core/no-unsafe-boundary-cast",
      "typescript-core/no-self-import",
      "typescript-core/fetch-must-check-ok",
      "typescript-core/json-parse-must-validate",
    ],
  });

  // React rules
  if (stack.hasReact || stack.frameworks.includes("react")) {
    packs.push({
      name: "react-component-architecture",
      description: "React component architecture and best practices",
      priority: "medium",
      rules: [
        "react-component-architecture/no-nested-component",
        "react-component-architecture/no-derived-state-in-effect",
        "react-component-architecture/no-jsx-computation",
        "react-component-architecture/component-file-purity",
        "react-component-architecture/forwardref-display-name",
      ],
    });
  }

  // Next.js rules
  if (stack.hasNextJs || stack.frameworks.includes("nextjs")) {
    packs.push({
      name: "nextjs",
      description: "Next.js App Router and architecture rules",
      priority: "high",
      rules: [
        "nextjs/server-only-modules-import-server-only",
        "nextjs/client-hooks-require-use-client",
        "nextjs/error-boundary-require-use-client",
        "nextjs/await-dynamic-request-apis",
        "nextjs/no-pages-router-data-fetching-in-app",
        "nextjs/no-internal-api-fetch",
      ],
    });
  }

  // Drizzle rules
  if (stack.hasDrizzle || stack.frameworks.includes("drizzle")) {
    packs.push({
      name: "drizzle",
      description: "Drizzle ORM query and schema rules",
      priority: "high",
      rules: [
        "drizzle/update-delete-must-have-where",
        "drizzle/no-nested-db-transaction",
        "drizzle/schema-files-must-not-import-driver",
        "drizzle/tables-must-have-timestamps",
        "drizzle/timestamp-must-specify-mode",
      ],
    });
  }

  // Prisma rules
  if (stack.hasPrisma || stack.frameworks.includes("prisma")) {
    packs.push({
      name: "prisma",
      description: "Prisma ORM best practices",
      priority: "high",
      rules: [
        "drizzle/update-delete-must-have-where", // Similar pattern
        "module-boundaries/no-import-build-output",
      ],
    });
  }

  // BullMQ rules
  if (stack.hasBullMQ || stack.frameworks.includes("bullmq")) {
    packs.push({
      name: "bullmq",
      description: "BullMQ job queue best practices",
      priority: "high",
      rules: [
        "bullmq/job-name-must-be-constant",
        "bullmq/job-options-must-set-attempts",
        "bullmq/queue-options-must-set-removeoncomplete",
        "bullmq/queue-options-must-set-removeonfail",
        "bullmq/worker-must-implement-close",
      ],
    });
  }

  // Tailwind rules
  if (stack.hasTailwind || stack.frameworks.includes("tailwind")) {
    packs.push({
      name: "tailwind",
      description: "Tailwind CSS best practices",
      priority: "low",
      rules: [
        "stylistic/tailwind-ordered-classes",
        "stylistic/tailwind-no-arbitrary-values",
      ],
    });
  }

  // Testing rules
  if (stack.frameworks.includes("vitest") || stack.frameworks.includes("jest")) {
    packs.push({
      name: "test-conventions",
      description: "Testing best practices",
      priority: "medium",
      rules: [
        "test-conventions/no-focused-tests",
        "test-conventions/no-conditional-expect",
        "test-conventions/fake-timers-must-be-restored",
      ],
    });
  }

  // Meta-rules (supply chain, config, etc.)
  packs.push({
    name: "meta-rules",
    description: "Project structure and configuration invariants",
    priority: "high",
    rules: [
      "supply-chain/lockfile-required",
      "supply-chain/no-undeclared-dependencies",
      "config/tsconfig-strict",
      "source-text/no-eslint-disable-comments",
      "source-text/no-ts-suppressions",
    ],
  });

  return packs;
}

/**
 * Format rule packs for inclusion in system prompt
 */
export function formatRulePacksForPrompt(packs: RulePack[]): string {
  if (packs.length === 0) return "";

  const lines: string[] = [];
  lines.push("## ACTIVE RULE PACKS");
  lines.push("");

  for (const pack of packs) {
    lines.push(`### ${pack.name.toUpperCase()} (${pack.priority} priority)`);
    lines.push(pack.description);
    lines.push("");
    lines.push("Active rules:");
    for (const rule of pack.rules) {
      lines.push(`  - ${rule}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
