/**
 * Goal Templates
 * Pre-defined goal templates for common development tasks
 */

import type { Goal } from "./goals";

export type GoalTemplate = {
  id: string;
  name: string;
  description: string;
  category: "development" | "testing" | "documentation" | "deployment" | "refactoring";
  createGoal: (params?: Record<string, string>) => Omit<Goal, "id" | "createdAt" | "updatedAt" | "status" | "checkpoints">;
};

export const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    id: "build-api",
    name: "Build REST API",
    description: "Create a complete REST API with authentication and validation",
    category: "development",
    createGoal: (params) => ({
      objective: params?.objective || "Build a REST API",
      constraints: [
        "Use TypeScript",
        "Follow REST conventions",
        "Include input validation",
        "Implement authentication",
      ],
      validateCommand: params?.validateCommand || "npm run test",
      stopCondition: params?.stopCondition || "All API endpoints return 200 and pass tests",
    }),
  },
  {
    id: "create-component",
    name: "Create React Component",
    description: "Build a reusable React component with tests",
    category: "development",
    createGoal: (params) => ({
      objective: params?.objective || "Create a React component",
      constraints: [
        "Use TypeScript",
        "Follow atomic design pattern",
        "Include unit tests",
        "Add Storybook documentation",
      ],
      validateCommand: params?.validateCommand || "npm run test",
      stopCondition: params?.stopCondition || "Component has 90%+ test coverage and passes all tests",
    }),
  },
  {
    id: "database-migration",
    name: "Database Migration",
    description: "Plan and execute a database migration safely",
    category: "development",
    createGoal: (params) => ({
      objective: params?.objective || "Migrate database schema",
      constraints: [
        "Create migration scripts",
        "Test on staging first",
        "Create rollback plan",
        "Backup before migration",
      ],
      validateCommand: params?.validateCommand || "npm run migrate:verify",
      stopCondition: params?.stopCondition || "Migration completes successfully with no data loss",
    }),
  },
  {
    id: "write-tests",
    name: "Write Unit Tests",
    description: "Add comprehensive unit tests to existing code",
    category: "testing",
    createGoal: (params) => ({
      objective: params?.objective || "Write unit tests",
      constraints: [
        "Achieve 80%+ code coverage",
        "Test edge cases",
        "Include integration tests",
        "Mock external dependencies",
      ],
      validateCommand: params?.validateCommand || "npm run test:coverage",
      stopCondition: params?.stopCondition || "All tests pass with 80%+ coverage",
    }),
  },
  {
    id: "documentation",
    name: "Write Documentation",
    description: "Create or update project documentation",
    category: "documentation",
    createGoal: (params) => ({
      objective: params?.objective || "Write project documentation",
      constraints: [
        "Include setup instructions",
        "Add API documentation",
        "Create examples",
        "Update README",
      ],
      validateCommand: params?.validateCommand || "npm run docs:build",
      stopCondition: params?.stopCondition || "All documentation builds without errors",
    }),
  },
  {
    id: "deploy-app",
    name: "Deploy Application",
    description: "Deploy application to production environment",
    category: "deployment",
    createGoal: (params) => ({
      objective: params?.objective || "Deploy application",
      constraints: [
        "Run all tests",
        "Build production bundle",
        "Configure environment variables",
        "Monitor deployment",
      ],
      validateCommand: params?.validateCommand || "npm run build",
      stopCondition: params?.stopCondition || "Application is live and accessible",
    }),
  },
  {
    id: "refactor-code",
    name: "Refactor Codebase",
    description: "Refactor code for better maintainability",
    category: "refactoring",
    createGoal: (params) => ({
      objective: params?.objective || "Refactor codebase",
      constraints: [
        "Maintain backward compatibility",
        "Write tests before refactoring",
        "Document changes",
        "Keep performance impact minimal",
      ],
      validateCommand: params?.validateCommand || "npm run test",
      stopCondition: params?.stopCondition || "All tests pass and code complexity is reduced",
    }),
  },
];

/**
 * Get template by ID
 */
export function getTemplate(id: string): GoalTemplate | undefined {
  return GOAL_TEMPLATES.find((t) => t.id === id);
}

/**
 * Get templates by category
 */
export function getTemplatesByCategory(category: GoalTemplate["category"]): GoalTemplate[] {
  return GOAL_TEMPLATES.filter((t) => t.category === category);
}

/**
 * Get all categories
 */
export function getCategories(): GoalTemplate["category"][] {
  return [...new Set(GOAL_TEMPLATES.map((t) => t.category))];
}
