/**
 * TypeScript Analyzer MCP Server - Enterprise Edition
 *  
 * A high-performance, production-grade MCP server for analyzing and fixing TypeScript 'any' types.
 * Built with extensive error handling, caching, and intelligent type inference.
 */

// Core imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import * as os from "os";
import { z } from "zod"; // Zod for validation
import pino from "pino"; // Structured logging

// =============================================================================
// Configuration Management
// =============================================================================

// Configuration schema with Zod
const ConfigSchema = z.object({
  server: z.object({
    name: z.string().default("typescript-analyzer"),
    version: z.string().default("2.0.0"),
    description: z.string().default("Advanced TypeScript analyzer and fixer for 'any' types"),
    logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    logFormat: z.enum(["pretty", "json"]).default("pretty"),
  }),
  analysis: z.object({
    maxFileSize: z.number().int().positive().default(10 * 1024 * 1024), // 10MB
    cacheEnabled: z.boolean().default(true),
    cacheDir: z.string().default(path.join(os.tmpdir(), "typescript-analyzer-cache")),
    cacheTTL: z.number().int().positive().default(3600000), // 1 hour
    ignorePatterns: z.array(z.string()).default([
      "**/node_modules/**", 
      "**/dist/**", 
      "**/build/**"
    ]),
  }),
  fix: z.object({
    defaultReplacement: z.enum(["unknown", "Record<string, unknown>", "object"]).default("unknown"),
    createBackups: z.boolean().default(true),
    backupDir: z.string().optional(),
    respectTsConfig: z.boolean().default(true),
  }),
  batch: z.object({
    concurrency: z.number().int().positive().default(os.cpus().length),
    progressReporting: z.boolean().default(true),
    progressInterval: z.number().int().positive().default(200), // ms
  }),
});

// Configuration type derived from schema
type Config = z.infer<typeof ConfigSchema>;

// Default configuration
const defaultConfig: Config = {
  server: {
    name: "typescript-analyzer",
    version: "2.0.0",
    description: "Advanced TypeScript analyzer and fixer for 'any' types",
    logLevel: "info",
    logFormat: "pretty",
  },
  analysis: {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    cacheEnabled: true,
    cacheDir: path.join(os.tmpdir(), "typescript-analyzer-cache"),
    cacheTTL: 3600000, // 1 hour
    ignorePatterns: ["**/node_modules/**", "**/dist/**", "**/build/**"],
  },
  fix: {
    defaultReplacement: "unknown",
    createBackups: true,
    respectTsConfig: true,
  },
  batch: {
    concurrency: os.cpus().length,
    progressReporting: true,
    progressInterval: 200, // ms
  },
};

// Get configuration from file or use defaults
function loadConfig(configPath?: string): Config {
  try {
    if (configPath && fs.existsSync(configPath)) {
      const fileContent = fs.readFileSync(configPath, "utf8");
      const fileConfig = JSON.parse(fileContent);
      return ConfigSchema.parse(deepMerge(defaultConfig, fileConfig));
    }
  } catch (error) {
    console.warn(`Warning: Failed to load config from ${configPath}: ${error.message}`);
    console.warn("Using default configuration");
  }
  
  return defaultConfig;
}

// Deep merge helper
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const merged = { ...target };
  
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) Object.assign(merged, { [key]: source[key] });
        else merged[key] = deepMerge(target[key], source[key]);
      } else {
        Object.assign(merged, { [key]: source[key] });
      }
    });
  }
  
  return merged;
}

// Type guard for objects
function isObject(item: any): item is Record<string, any> {
  return item && typeof item === "object" && !Array.isArray(item);
}

// =============================================================================
// Logging System
// =============================================================================

// Create logger
function createLogger(config: Config) {
  const prettyPrint = config.server.logFormat === "pretty";
  
  // Use type assertion to handle the pino import issue
  return (pino as any)({
    level: config.server.logLevel,
    transport: prettyPrint
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname",
            translateTime: "yyyy-mm-dd HH:MM:ss.l",
          },
        }
      : undefined,
  });
}

// =============================================================================
// Cache Service
// =============================================================================

// Cache entry interface
interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

// Cache service for improved performance
class CacheService {
  private cacheDir: string;
  private ttl: number;
  private enabled: boolean;
  private logger: pino.Logger;
  
  constructor(config: Config, logger: pino.Logger) {
    this.cacheDir = config.analysis.cacheDir;
    this.ttl = config.analysis.cacheTTL;
    this.enabled = config.analysis.cacheEnabled;
    this.logger = logger.child({ component: "cache" });
    
    // Ensure cache directory exists if caching is enabled
    if (this.enabled) {
      try {
        if (!fs.existsSync(this.cacheDir)) {
          fs.mkdirSync(this.cacheDir, { recursive: true });
        }
      } catch (error) {
        this.logger.warn({ error }, "Failed to create cache directory, disabling cache");
        this.enabled = false;
      }
    }
  }
  
  // Generate cache key
  private getCacheKey(key: string): string {
    return crypto.createHash("md5").update(key).digest("hex");
  }
  
  // Get cache file path
  private getCachePath(key: string): string {
    return path.join(this.cacheDir, `${this.getCacheKey(key)}.json`);
  }
  
  // Set cache value
  set<T>(key: string, data: T): void {
    if (!this.enabled) return;
    
    try {
      const cachePath = this.getCachePath(key);
      const entry: CacheEntry<T> = {
        timestamp: Date.now(),
        data,
      };
      
      fs.writeFileSync(cachePath, JSON.stringify(entry));
      this.logger.debug({ key }, "Cache entry set");
    } catch (error) {
      this.logger.warn({ error, key }, "Failed to set cache entry");
    }
  }
  
  // Get cache value
  get<T>(key: string): T | null {
    if (!this.enabled) return null;
    
    try {
      const cachePath = this.getCachePath(key);
      
      if (!fs.existsSync(cachePath)) {
        return null;
      }
      
      const content = fs.readFileSync(cachePath, "utf8");
      const entry = JSON.parse(content) as CacheEntry<T>;
      
      // Check if entry is expired
      if (Date.now() - entry.timestamp > this.ttl) {
        this.logger.debug({ key }, "Cache entry expired");
        fs.unlinkSync(cachePath);
        return null;
      }
      
      this.logger.debug({ key }, "Cache hit");
      return entry.data;
    } catch (error) {
      this.logger.warn({ error, key }, "Failed to get cache entry");
      return null;
    }
  }
  
  // Clear all cache entries
  clear(): void {
    if (!this.enabled) return;
    
    try {
      const files = fs.readdirSync(this.cacheDir);
      
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(this.cacheDir, file));
        } catch (error) {
          this.logger.warn({ error, file }, "Failed to delete cache file");
        }
      }
      
      this.logger.info({ count: files.length }, "Cache cleared");
    } catch (error) {
      this.logger.error({ error }, "Failed to clear cache");
    }
  }
}

// =============================================================================
// File System Utilities
// =============================================================================

// File system service for safe file operations
class FileSystemService {
  private logger: pino.Logger;
  private config: Config;
  
  constructor(config: Config, logger: pino.Logger) {
    this.config = config;
    this.logger = logger.child({ component: "fs" });
  }
  
  // Safely read a file with max size check
  readFile(filePath: string): string {
    try {
      // Ensure file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      
      // Check file size
      const stats = fs.statSync(filePath);
      if (stats.size > this.config.analysis.maxFileSize) {
        throw new Error(
          `File too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB exceeds max size of ${(this.config.analysis.maxFileSize / 1024 / 1024).toFixed(2)}MB`
        );
      }
      
      // Read file
      const content = fs.readFileSync(filePath, "utf8");
      this.logger.debug({ filePath, size: stats.size }, "File read successfully");
      return content;
    } catch (error) {
      this.logger.error({ error, filePath }, "Failed to read file");
      throw error;
    }
  }
  
  // Create backup of a file before modifying
  createBackup(filePath: string): string {
    if (!this.config.fix.createBackups) return null;
    
    try {
      const content = this.readFile(filePath);
      const backupDir = this.config.fix.backupDir || path.dirname(filePath);
      
      // Ensure backup directory exists
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      
      // Create backup file name with timestamp
      const timestamp = new Date().toISOString().replace(/[:\.]/g, "-");
      const fileName = path.basename(filePath);
      const backupFilePath = path.join(backupDir, `${fileName}.${timestamp}.bak`);
      
      // Write backup
      fs.writeFileSync(backupFilePath, content);
      this.logger.info({ original: filePath, backup: backupFilePath }, "Backup created");
      
      return backupFilePath;
    } catch (error) {
      this.logger.error({ error, filePath }, "Failed to create backup");
      throw error;
    }
  }
  
  // Safe write to file
  writeFile(filePath: string, content: string): void {
    try {
      const dirname = path.dirname(filePath);
      
      // Ensure directory exists
      if (!fs.existsSync(dirname)) {
        fs.mkdirSync(dirname, { recursive: true });
      }
      
      // Write file
      fs.writeFileSync(filePath, content);
      this.logger.debug({ filePath }, "File written successfully");
    } catch (error) {
      this.logger.error({ error, filePath }, "Failed to write file");
      throw error;
    }
  }
  
  // Find files matching a pattern (simplified glob)
  findFiles(directory: string, pattern: string): string[] {
    const filePatternRegex = this.globToRegex(pattern);
    const ignorePatterns = this.config.analysis.ignorePatterns.map(this.globToRegex);
    const results: string[] = [];
    
    const searchDirectory = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          // Check if path should be ignored
          if (ignorePatterns.some(regex => regex.test(fullPath))) {
            continue;
          }
          
          if (entry.isDirectory()) {
            searchDirectory(fullPath);
          } else if (entry.isFile() && filePatternRegex.test(entry.name)) {
            results.push(fullPath);
          }
        }
      } catch (error) {
        this.logger.warn({ error, directory: dir }, "Error reading directory");
      }
    };
    
    searchDirectory(directory);
    return results;
  }
  
  // Convert glob pattern to RegExp
  private globToRegex(pattern: string): RegExp {
    // Basic glob pattern conversion - a more robust solution would use micromatch or similar
    const regexPattern = pattern
      .replace(/\./g, "\\.") // Escape dots
      .replace(/\*\*/g, "###GLOBSTAR###") // Temporarily replace globstar
      .replace(/\*/g, "[^/]*") // Replace * with non-slash characters
      .replace(/###GLOBSTAR###/g, ".*") // Replace globstar with any characters
      .replace(/\?/g, "."); // Replace ? with any single character
    
    return new RegExp(`^${regexPattern}$`, "i");
  }
}

// =============================================================================
// Type Inference System
// =============================================================================

// Context-aware type mapping
interface ContextAwareTypeMapping {
  pattern: string | RegExp;
  replacement: string;
  context?: {
    parentKind?: ts.SyntaxKind | ts.SyntaxKind[];
    usage?: "jsx" | "comparison" | "arithmetic" | "function" | "dom" | "array" | "object";
    filePattern?: string;
  };
  description?: string;
}

// Advanced type mappings with context awareness
const TYPE_MAPPINGS: ContextAwareTypeMapping[] = [
  // Event handlers
  {
    pattern: /e: any/,
    replacement: "e: React.SyntheticEvent",
    context: { usage: "jsx" },
    description: "Generic React event handler"
  },
  {
    pattern: /event: any/,
    replacement: "event: React.SyntheticEvent",
    context: { usage: "jsx" },
    description: "Generic React event handler"
  },
  {
    pattern: /onChange: any/,
    replacement: "onChange: (value: unknown) => void",
    context: { usage: "jsx" },
    description: "Generic change handler"
  },
  {
    pattern: /onClick: any/,
    replacement: "onClick: (event: React.MouseEvent<HTMLElement>) => void",
    context: { usage: "jsx" },
    description: "Click event handler"
  },
  {
    pattern: /onSubmit: any/,
    replacement: "onSubmit: (event: React.FormEvent<HTMLFormElement>) => void",
    context: { usage: "jsx" },
    description: "Form submission handler"
  },
  {
    pattern: /onInput: any/,
    replacement: "onInput: (event: React.FormEvent<HTMLInputElement>) => void",
    context: { usage: "jsx" },
    description: "Input event handler"
  },
  {
    pattern: /onBlur: any/,
    replacement: "onBlur: (event: React.FocusEvent<HTMLElement>) => void",
    context: { usage: "jsx" },
    description: "Blur event handler"
  },
  {
    pattern: /onFocus: any/,
    replacement: "onFocus: (event: React.FocusEvent<HTMLElement>) => void",
    context: { usage: "jsx" },
    description: "Focus event handler"
  },
  {
    pattern: /onKeyDown: any/,
    replacement: "onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void",
    context: { usage: "jsx" },
    description: "Keyboard event handler"
  },
  {
    pattern: /onKeyUp: any/,
    replacement: "onKeyUp: (event: React.KeyboardEvent<HTMLElement>) => void",
    context: { usage: "jsx" },
    description: "Keyboard event handler"
  },
  {
    pattern: /onKeyPress: any/,
    replacement: "onKeyPress: (event: React.KeyboardEvent<HTMLElement>) => void",
    context: { usage: "jsx" },
    description: "Keyboard event handler"
  },
  
  // DOM elements
  {
    pattern: /ref: any/,
    replacement: "ref: React.RefObject<HTMLElement>",
    context: { usage: "dom" },
    description: "Generic DOM reference"
  },
  {
    pattern: /buttonRef: any/,
    replacement: "buttonRef: React.RefObject<HTMLButtonElement>",
    context: { usage: "dom" },
    description: "Button DOM reference"
  },
  {
    pattern: /inputRef: any/,
    replacement: "inputRef: React.RefObject<HTMLInputElement>",
    context: { usage: "dom" },
    description: "Input DOM reference"
  },
  {
    pattern: /formRef: any/,
    replacement: "formRef: React.RefObject<HTMLFormElement>",
    context: { usage: "dom" },
    description: "Form DOM reference"
  },
  {
    pattern: /divRef: any/,
    replacement: "divRef: React.RefObject<HTMLDivElement>",
    context: { usage: "dom" },
    description: "Div DOM reference"
  },
  
  // Common data structures
  {
    pattern: /data: any/,
    replacement: "data: Record<string, unknown>",
    context: { usage: "object" },
    description: "Generic data object"
  },
  {
    pattern: /options: any/,
    replacement: "options: Record<string, unknown>",
    context: { usage: "object" },
    description: "Options configuration object"
  },
  {
    pattern: /config: any/,
    replacement: "config: Record<string, unknown>",
    context: { usage: "object" },
    description: "Configuration object"
  },
  {
    pattern: /props: any/,
    replacement: "props: Record<string, unknown>",
    context: { usage: "object" },
    description: "Component props object"
  },
  {
    pattern: /state: any/,
    replacement: "state: Record<string, unknown>",
    context: { usage: "object" },
    description: "Component state object"
  },
  {
    pattern: /context: any/,
    replacement: "context: Record<string, unknown>",
    context: { usage: "object" },
    description: "Context object"
  },
  
  // Array types
  {
    pattern: /items: any\[\]/,
    replacement: "items: unknown[]",
    context: { usage: "array" },
    description: "Generic items array"
  },
  {
    pattern: /results: any\[\]/,
    replacement: "results: unknown[]",
    context: { usage: "array" },
    description: "Results array"
  },
  {
    pattern: /users: any\[\]/,
    replacement: "users: { id: string; name: string; [key: string]: unknown }[]",
    context: { usage: "array" },
    description: "Users array with common properties"
  },
  {
    pattern: /rows: any\[\]/,
    replacement: "rows: Record<string, unknown>[]",
    context: { usage: "array" },
    description: "Data rows array"
  },
  
  // Function types
  {
    pattern: /callback: any/,
    replacement: "callback: (...args: unknown[]) => unknown",
    context: { usage: "function" },
    description: "Generic callback function"
  },
  {
    pattern: /handler: any/,
    replacement: "handler: (...args: unknown[]) => unknown",
    context: { usage: "function" },
    description: "Generic event handler function"
  },
  {
    pattern: /fn: any/,
    replacement: "fn: (...args: unknown[]) => unknown",
    context: { usage: "function" },
    description: "Generic function"
  },
  {
    pattern: /formatter: any/,
    replacement: "formatter: (value: unknown) => string",
    context: { usage: "function" },
    description: "Formatter function"
  },
  {
    pattern: /validator: any/,
    replacement: "validator: (value: unknown) => boolean",
    context: { usage: "function" },
    description: "Validator function"
  },
  
  // API and common web concepts
  {
    pattern: /response: any/,
    replacement: "response: { data?: unknown; status?: number; [key: string]: unknown }",
    context: { usage: "object" },
    description: "API response object"
  },
  {
    pattern: /error: any/,
    replacement: "error: Error | unknown",
    context: { usage: "object" },
    description: "Error object"
  },
  {
    pattern: /params: any/,
    replacement: "params: Record<string, string | number | boolean>",
    context: { usage: "object" },
    description: "Route or query parameters"
  },
];

// Type analyzer service
class TypeScriptAnalyzerService {
  private logger: pino.Logger;
  private cache: CacheService;
  private fs: FileSystemService;
  private config: Config;
  
  constructor(config: Config, logger: pino.Logger, cache: CacheService, fs: FileSystemService) {
    this.config = config;
    this.logger = logger.child({ component: "analyzer" });
    this.cache = cache;
    this.fs = fs;
  }
  
  // Analyze a TypeScript file for 'any' types
  async analyzeFile(filePath: string): Promise<AnalysisResult> {
    this.logger.debug({ filePath }, "Analyzing file");
    
    try {
      // Generate file hash for cache key
      const fileContent = this.fs.readFile(filePath);
      const fileHash = calculateHash(fileContent);
      const cacheKey = `analysis:${filePath}:${fileHash}`;
      
      // Check cache
      const cachedResult = this.cache.get<AnalysisResult>(cacheKey);
      if (cachedResult) {
        this.logger.debug({ filePath }, "Using cached analysis result");
        return cachedResult;
      }
      
      // Create source file
      const sourceFile = ts.createSourceFile(
        path.basename(filePath),
        fileContent,
        ts.ScriptTarget.Latest,
        true
      );
      
      // Initialize analysis results
      const analysis: AnalysisResult = {
        success: true,
        filePath,
        patterns: [],
        totalPatterns: 0,
        fileHash
      };
      
      // Visit nodes to find 'any' types
      this.visitNodes(sourceFile, analysis);
      
      // Update statistics
      analysis.totalPatterns = analysis.patterns.length;
      
      // Cache result
      this.cache.set(cacheKey, analysis);
      
      this.logger.info(
        { filePath, totalPatterns: analysis.totalPatterns },
        "File analysis complete"
      );
      
      return analysis;
    } catch (error) {
      this.logger.error({ error, filePath }, "Error analyzing file");
      throw error;
    }
  }
  
  // Visit AST nodes
  private visitNodes(sourceFile: ts.SourceFile, analysis: AnalysisResult) {
    const visitNode = (node: ts.Node) => {
      // Check for 'any' type
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const parent = node.parent;
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        
        // Get context info
        const context = this.getNodeContext(node, sourceFile);
        
        // Extract pattern and find suggestion
        const { pattern, suggestion } = this.extractPatternAndSuggestion(
          node,
          parent,
          sourceFile,
          context
        );
        
        // Add to patterns found
        analysis.patterns.push({
          pattern,
          line: position.line + 1,
          character: position.character,
          suggestion,
          nodeKind: node.kind,
          parentKind: parent?.kind,
          context
        });
      }
      
      // Recursively visit children
      ts.forEachChild(node, visitNode);
    };
    
    visitNode(sourceFile);
  }
  
  // Get node context
  private getNodeContext(node: ts.Node, sourceFile: ts.SourceFile): string {
    let context = "unknown";
    let parent = node.parent;
    
    // Check for JSX context
    if (this.isInJsxContext(node)) {
      context = "jsx";
    }
    // Check for comparison context
    else if (this.isInComparisonContext(node)) {
      context = "comparison";
    }
    // Check for arithmetic context
    else if (this.isInArithmeticContext(node)) {
      context = "arithmetic";
    }
    // Check for function context
    else if (this.isInFunctionContext(node)) {
      context = "function";
    }
    // Check for DOM context
    else if (this.isInDomContext(node, sourceFile)) {
      context = "dom";
    }
    // Check for array context
    else if (this.isInArrayContext(node)) {
      context = "array";
    }
    // Check for object context
    else if (this.isInObjectContext(node)) {
      context = "object";
    }
    
    return context;
  }
  
  // Various context detection helpers
  private isInJsxContext(node: ts.Node): boolean {
    let current = node;
    while (current) {
      if (
        ts.isJsxElement(current) ||
        ts.isJsxAttribute(current) ||
        ts.isJsxOpeningElement(current) ||
        ts.isJsxSelfClosingElement(current)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }
  
  private isInComparisonContext(node: ts.Node): boolean {
    let current = node;
    while (current && current.parent) {
      if (
        ts.isBinaryExpression(current.parent) &&
        [
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.LessThanToken,
          ts.SyntaxKind.GreaterThanToken,
          ts.SyntaxKind.LessThanEqualsToken,
          ts.SyntaxKind.GreaterThanEqualsToken,
        ].includes(current.parent.operatorToken.kind)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }
  
  private isInArithmeticContext(node: ts.Node): boolean {
    let current = node;
    while (current && current.parent) {
      if (
        ts.isBinaryExpression(current.parent) &&
        [
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.AsteriskToken,
          ts.SyntaxKind.SlashToken,
          ts.SyntaxKind.PercentToken,
        ].includes(current.parent.operatorToken.kind)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }
  
  private isInFunctionContext(node: ts.Node): boolean {
    let current = node;
    while (current) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }
  
  private isInDomContext(node: ts.Node, sourceFile: ts.SourceFile): boolean {
    let current = node;
    while (current && current.parent) {
      // Check if there's a reference to document, element, or DOM types
      if (
        ts.isPropertyAccessExpression(current) &&
        (current.expression.getText(sourceFile).includes("document") ||
          current.expression.getText(sourceFile).includes("Element"))
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }
  
  private isInArrayContext(node: ts.Node): boolean {
    return (
      (node.parent && ts.isArrayTypeNode(node.parent)) ||
      (node.parent && node.parent.parent && ts.isArrayLiteralExpression(node.parent.parent))
    );
  }
  
  private isInObjectContext(node: ts.Node): boolean {
    let current = node;
    while (current) {
      if (
        ts.isObjectLiteralExpression(current) ||
        ts.isInterfaceDeclaration(current) ||
        ts.isTypeLiteralNode(current)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }
  
  // Extract pattern and suggestion based on node context
  private extractPatternAndSuggestion(
    node: ts.Node,
    parent: ts.Node,
    sourceFile: ts.SourceFile,
    context: string
  ): { pattern: string; suggestion: string } {
    let pattern = "";
    let suggestion = "unknown";
    
    // Handle parameter
    if (ts.isParameter(parent)) {
      const paramName = parent.name.getText(sourceFile);
      pattern = `${paramName}: any`;
      
      // Find in mappings
      const mapping = this.findTypeMapping(pattern, {
        parentKind: parent.kind,
        usage: context as any,
      });
      
      if (mapping) {
        suggestion = mapping.replacement.split(": ")[1];
      } else {
        // Infer from usage
        suggestion = this.inferTypeFromUsage(parent, sourceFile) || suggestion;
      }
    }
    // Handle property signature
    else if (ts.isPropertySignature(parent)) {
      const propName = parent.name.getText(sourceFile);
      pattern = `${propName}: any`;
      
      // Find in mappings
      const mapping = this.findTypeMapping(pattern, {
        parentKind: parent.kind,
        usage: context as any,
      });
      
      if (mapping) {
        suggestion = mapping.replacement.split(": ")[1];
      } else {
        // Infer from property name patterns
        suggestion = this.inferTypeFromPropertyName(propName) || suggestion;
      }
    }
    // Handle type reference
    else if (ts.isTypeReferenceNode(parent)) {
      pattern = parent.getText(sourceFile);
      suggestion = pattern.replace("any", "unknown");
    }
    // Handle array type
    else if (ts.isArrayTypeNode(parent)) {
      pattern = "any[]";
      suggestion = "unknown[]";
    }
    // Handle other cases
    else {
      pattern = "any";
      suggestion = "unknown";
    }
    
    return { pattern, suggestion };
  }
  
  // Find matching type mapping
  private findTypeMapping(
    pattern: string,
    context: Partial<ContextAwareTypeMapping["context"]>
  ): ContextAwareTypeMapping | undefined {
    return TYPE_MAPPINGS.find(mapping => {
      const patternMatches =
        typeof mapping.pattern === "string"
          ? mapping.pattern === pattern
          : mapping.pattern.test(pattern);
      
      if (!patternMatches) return false;
      
      // If mapping has no context requirements, it's a match
      if (!mapping.context) return true;
      
      // Check parent kind
      if (mapping.context.parentKind !== undefined) {
        const parentKindMatches = Array.isArray(mapping.context.parentKind)
          ? mapping.context.parentKind.includes(context.parentKind as ts.SyntaxKind)
          : mapping.context.parentKind === context.parentKind;
        
        if (!parentKindMatches) return false;
      }
      
      // Check usage context
      if (
        mapping.context.usage !== undefined &&
        mapping.context.usage !== context.usage
      ) {
        return false;
      }
      
      return true;
    });
  }
  
  // Infer type from usage
  private inferTypeFromUsage(node: ts.Node, sourceFile: ts.SourceFile): string | null {
    // Find function that contains this parameter
    let functionNode = node.parent;
    while (
      functionNode &&
      !ts.isFunctionDeclaration(functionNode) &&
      !ts.isFunctionExpression(functionNode) &&
      !ts.isArrowFunction(functionNode) &&
      !ts.isMethodDeclaration(functionNode)
    ) {
      functionNode = functionNode.parent;
    }
    
    // Check if functionNode is a type that has a body property
    if (!functionNode ||
        !(ts.isFunctionDeclaration(functionNode) ||
          ts.isFunctionExpression(functionNode) ||
          ts.isArrowFunction(functionNode) ||
          ts.isMethodDeclaration(functionNode)) ||
        !functionNode.body) return null;
    
    const paramName = (node as ts.ParameterDeclaration).name.getText(sourceFile);
    let inferredType: string = null;
    
    // Analyze function body to infer parameter type
    const visitFunctionBody = (bodyNode: ts.Node) => {
      // Check for parameter usage in comparisons
      if (
        ts.isBinaryExpression(bodyNode) &&
        [
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(bodyNode.operatorToken.kind)
      ) {
        // If param is compared with boolean
        if (
          (bodyNode.left.getText(sourceFile) === paramName &&
            (bodyNode.right.getText(sourceFile) === "true" ||
              bodyNode.right.getText(sourceFile) === "false")) ||
          (bodyNode.right.getText(sourceFile) === paramName &&
            (bodyNode.left.getText(sourceFile) === "true" ||
              bodyNode.left.getText(sourceFile) === "false"))
        ) {
          inferredType = "boolean";
          return;
        }
        
        // If param is compared with number
        if (
          (bodyNode.left.getText(sourceFile) === paramName &&
            !isNaN(Number(bodyNode.right.getText(sourceFile)))) ||
          (bodyNode.right.getText(sourceFile) === paramName &&
            !isNaN(Number(bodyNode.left.getText(sourceFile))))
        ) {
          inferredType = "number";
          return;
        }
        
        // If param is compared with string
        if (
          (bodyNode.left.getText(sourceFile) === paramName &&
            bodyNode.right.kind === ts.SyntaxKind.StringLiteral) ||
          (bodyNode.right.getText(sourceFile) === paramName &&
            bodyNode.left.kind === ts.SyntaxKind.StringLiteral)
        ) {
          inferredType = "string";
          return;
        }
      }
      
      // Check for arithmetic operations
      if (
        ts.isBinaryExpression(bodyNode) &&
        [
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.AsteriskToken,
          ts.SyntaxKind.SlashToken,
          ts.SyntaxKind.PercentToken,
        ].includes(bodyNode.operatorToken.kind)
      ) {
        if (
          bodyNode.left.getText(sourceFile) === paramName ||
          bodyNode.right.getText(sourceFile) === paramName
        ) {
          // For + operator, could be string or number
          if (bodyNode.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            // If other operand is string literal, likely string
            if (
              (bodyNode.left.getText(sourceFile) === paramName &&
                bodyNode.right.kind === ts.SyntaxKind.StringLiteral) ||
              (bodyNode.right.getText(sourceFile) === paramName &&
                bodyNode.left.kind === ts.SyntaxKind.StringLiteral)
            ) {
              inferredType = "string";
              return;
            }
            // Otherwise assume number
            inferredType = "number";
            return;
          } else {
            // Other arithmetic operators
            inferredType = "number";
            return;
          }
        }
      }
      
      // Check for property access (likely object)
      if (
        ts.isPropertyAccessExpression(bodyNode) &&
        bodyNode.expression.getText(sourceFile) === paramName
      ) {
        inferredType = "Record<string, unknown>";
        return;
      }
      
      // Check for element access (likely array or object)
      if (
        ts.isElementAccessExpression(bodyNode) &&
        bodyNode.expression.getText(sourceFile) === paramName
      ) {
        // Check argument type
        if (bodyNode.argumentExpression.kind === ts.SyntaxKind.NumericLiteral) {
          inferredType = "unknown[]";
        } else {
          inferredType = "Record<string, unknown>";
        }
        return;
      }
      
      // Check for function calls (is the param being called?)
      if (
        ts.isCallExpression(bodyNode) &&
        bodyNode.expression.getText(sourceFile) === paramName
      ) {
        inferredType = "(...args: unknown[]) => unknown";
        return;
      }
      
      // Continue visiting child nodes
      ts.forEachChild(bodyNode, visitFunctionBody);
    };
    
    if (ts.isFunctionDeclaration(functionNode) ||
        ts.isFunctionExpression(functionNode) ||
        ts.isArrowFunction(functionNode) ||
        ts.isMethodDeclaration(functionNode)) {
      visitFunctionBody(functionNode.body);
    }
    
    return inferredType;
  }
  
  // Infer type from property name
  private inferTypeFromPropertyName(propName: string): string | null {
    // Common property name patterns
    if (/id$/i.test(propName) || /key$/i.test(propName)) {
      return "string";
    }
    
    if (
      /enabled$/i.test(propName) ||
      /visible$/i.test(propName) ||
      /active$/i.test(propName) ||
      /selected$/i.test(propName) ||
      /checked$/i.test(propName) ||
      /is[A-Z]/i.test(propName) ||
      /has[A-Z]/i.test(propName) ||
      /should[A-Z]/i.test(propName) ||
      /can[A-Z]/i.test(propName)
    ) {
      return "boolean";
    }
    
    if (
      /count$/i.test(propName) ||
      /length$/i.test(propName) ||
      /index$/i.test(propName) ||
      /size$/i.test(propName) ||
      /width$/i.test(propName) ||
      /height$/i.test(propName) ||
      /amount$/i.test(propName) ||
      /sum$/i.test(propName) ||
      /total$/i.test(propName) ||
      /limit$/i.test(propName) ||
      /offset$/i.test(propName) ||
      /duration$/i.test(propName)
    ) {
      return "number";
    }
    
    if (
      /date$/i.test(propName) ||
      /time$/i.test(propName) ||
      /timestamp$/i.test(propName) ||
      /created[A-Z]/i.test(propName) ||
      /updated[A-Z]/i.test(propName) ||
      /deleted[A-Z]/i.test(propName)
    ) {
      return "Date | string";
    }
    
    if (
      /items$/i.test(propName) ||
      /records$/i.test(propName) ||
      /results$/i.test(propName) ||
      /data$/i.test(propName) ||
      /list$/i.test(propName) ||
      /collection$/i.test(propName) ||
      /array$/i.test(propName) ||
      /elements$/i.test(propName) ||
      /rows$/i.test(propName) ||
      /entries$/i.test(propName)
    ) {
      return "unknown[]";
    }
    
    if (
      /handler$/i.test(propName) ||
      /callback$/i.test(propName) ||
      /fn$/i.test(propName) ||
      /func$/i.test(propName) ||
      /function$/i.test(propName) ||
      /action$/i.test(propName) ||
      /on[A-Z]/i.test(propName)
    ) {
      return "(...args: unknown[]) => unknown";
    }
    
    if (
      /options$/i.test(propName) ||
      /config$/i.test(propName) ||
      /settings$/i.test(propName) ||
      /props$/i.test(propName) ||
      /attributes$/i.test(propName) ||
      /params$/i.test(propName) ||
      /parameters$/i.test(propName) ||
      /metadata$/i.test(propName) ||
      /context$/i.test(propName) ||
      /state$/i.test(propName)
    ) {
      return "Record<string, unknown>";
    }
    
    return null;
  }
  
  // Fix 'any' types in a file
  async fixFile(
    filePath: string,
    options: {
      fixType?: string;
      dryRun?: boolean;
      analyze?: boolean;
    } = {}
  ): Promise<FixResult> {
    const {
      fixType = this.config.fix.defaultReplacement,
      dryRun = false,
      analyze = true,
    } = options;
    
    this.logger.debug({ filePath, options }, "Fixing file");
    
    try {
      // Create backup if not dry run
      let backupPath: string = null;
      if (!dryRun && this.config.fix.createBackups) {
        backupPath = this.fs.createBackup(filePath);
      }
      
      // Analysis needed?
      let analysis: AnalysisResult = null;
      if (analyze) {
        analysis = await this.analyzeFile(filePath);
      }
      
      // Read file content
      const fileContent = this.fs.readFile(filePath);
      
      // Create source file
      const sourceFile = ts.createSourceFile(
        path.basename(filePath),
        fileContent,
        ts.ScriptTarget.Latest,
        true
      );
      
      // Collect changes
      const changes: FixChange[] = [];
      
      // Visit nodes to find 'any' types
      const visitNode = (node: ts.Node) => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) {
          const parent = node.parent;
          let replacement = fixType;
          
          // Get context info
          const context = this.getNodeContext(node, sourceFile);
          
          // Determine appropriate replacement based on context
          const { pattern, suggestion } = this.extractPatternAndSuggestion(
            node,
            parent,
            sourceFile,
            context
          );
          
          // Use suggested replacement
          replacement = suggestion;
          
          // Store the change
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          changes.push({
            start: node.getStart(),
            end: node.getEnd(),
            original: "any",
            replacement,
            line: position.line + 1,
            character: position.character,
            pattern,
          });
        }
        
        ts.forEachChild(node, visitNode);
      };
      
      visitNode(sourceFile);
      
      // Apply changes (in reverse order to preserve positions)
      let newContent = fileContent;
      if (!dryRun && changes.length > 0) {
        changes.sort((a, b) => b.start - a.start);
        
        for (const change of changes) {
          newContent =
            newContent.substring(0, change.start) +
            change.replacement +
            newContent.substring(change.end);
        }
        
        // Write changes to file
        this.fs.writeFile(filePath, newContent);
      }
      
      const result: FixResult = {
        success: true,
        filePath,
        changes,
        totalChanges: changes.length,
        appliedChanges: !dryRun,
        backupCreated: backupPath !== null,
        backupPath,
      };
      
      this.logger.info(
        { filePath, totalChanges: result.totalChanges, applied: result.appliedChanges },
        "File fix complete"
      );
      
      return result;
    } catch (error) {
      this.logger.error({ error, filePath }, "Error fixing file");
      throw error;
    }
  }
  
  // Generate interface for React component
  async generateComponentInterface(
    filePath: string,
    componentName: string,
    outputPath?: string
  ): Promise<ComponentInterfaceResult> {
    this.logger.debug({ filePath, componentName }, "Generating component interface");
    
    try {
      // Read file content
      const fileContent = this.fs.readFile(filePath);
      
      // Create source file
      const sourceFile = ts.createSourceFile(
        path.basename(filePath),
        fileContent,
        ts.ScriptTarget.Latest,
        true
      );
      
      // Find component and props usage
      const propTypes = new Map<
        string,
        {
          type: string;
          required: boolean;
          description: string;
        }
      >();
      
      let componentFound = false;
      let componentType: "function" | "class" | "arrow" | "memo" = null;
      
      const findComponent = (node: ts.Node) => {
        // Check for function component declaration
        if (
          ts.isFunctionDeclaration(node) &&
          node.name?.getText(sourceFile) === componentName
        ) {
          componentFound = true;
          componentType = "function";
          this.analyzeComponentProps(node, propTypes, sourceFile);
          return;
        }
        
        // Check for variable declarations (arrow functions, React.memo)
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(sourceFile) === componentName
        ) {
          componentFound = true;
          
          if (node.initializer) {
            // Arrow function component
            if (ts.isArrowFunction(node.initializer)) {
              componentType = "arrow";
              this.analyzeComponentProps(node.initializer, propTypes, sourceFile);
              return;
            }
            
            // React.memo wrapped component
            if (
              ts.isCallExpression(node.initializer) &&
              node.initializer.expression.getText(sourceFile).includes("memo")
            ) {
              componentType = "memo";
              
              // Extract the wrapped component
              const args = node.initializer.arguments;
              if (args.length > 0 && ts.isArrowFunction(args[0])) {
                this.analyzeComponentProps(args[0], propTypes, sourceFile);
                return;
              }
            }
          }
        }
        
        // Check for class component
        if (
          ts.isClassDeclaration(node) &&
          node.name?.getText(sourceFile) === componentName
        ) {
          componentFound = true;
          componentType = "class";
          this.analyzeClassComponentProps(node, propTypes, sourceFile);
          return;
        }
        
        // Continue searching if component not found
        if (!componentFound) {
          ts.forEachChild(node, findComponent);
        }
      };
      
      findComponent(sourceFile);
      
      if (!componentFound) {
        return {
          success: false,
          error: `Component ${componentName} not found in file`,
          component: componentName,
          filePath,
        };
      }
      
      // Generate interface content
      const interfaceContent = this.generateInterfaceCode(componentName, propTypes);
      
      // Save to file if outputPath provided
      if (outputPath) {
        this.fs.writeFile(outputPath, interfaceContent);
      }
      
      return {
        success: true,
        component: componentName,
        componentType,
        interface: interfaceContent,
        props: Array.from(propTypes.entries()).map(([name, info]) => ({
          name,
          type: info.type,
          required: info.required,
          description: info.description,
        })),
        writtenToFile: !!outputPath,
        outputPath,
        filePath,
      };
    } catch (error) {
      this.logger.error({ error, filePath, componentName }, "Error generating component interface");
      throw error;
    }
  }
  
  // Analyze props of a component
  private analyzeComponentProps(
    node: ts.FunctionDeclaration | ts.ArrowFunction,
    propTypes: Map<string, { type: string; required: boolean; description: string }>,
    sourceFile: ts.SourceFile
  ) {
    // Get the props parameter
    const parameters = node.parameters;
    if (parameters.length === 0) return;
    
    const propsParam = parameters[0];
    const propsName = propsParam.name.getText(sourceFile);
    
    // Check if props has a type annotation
    if (propsParam.type) {
      this.extractPropsFromTypeAnnotation(propsParam.type, propTypes, sourceFile);
    }
    
    // If not, we need to infer from usage
    if (node.body) {
      this.extractPropsFromUsage(node.body, propsName, propTypes, sourceFile);
    }
  }
  
  // Extract props from type annotation
  private extractPropsFromTypeAnnotation(
    typeNode: ts.TypeNode,
    propTypes: Map<string, { type: string; required: boolean; description: string }>,
    sourceFile: ts.SourceFile
  ) {
    // Check for interface or type reference
    if (ts.isTypeReferenceNode(typeNode)) {
      const typeName = typeNode.typeName.getText(sourceFile);
      
      // Find the type definition in the source file
      const findType = (node: ts.Node) => {
        // Interface declaration
        if (
          ts.isInterfaceDeclaration(node) &&
          node.name.getText(sourceFile) === typeName
        ) {
          this.extractPropsFromInterface(node, propTypes, sourceFile);
          return true;
        }
        
        // Type alias
        if (
          ts.isTypeAliasDeclaration(node) &&
          node.name.getText(sourceFile) === typeName
        ) {
          if (node.type) {
            if (ts.isTypeLiteralNode(node.type)) {
              this.extractPropsFromTypeLiteral(node.type, propTypes, sourceFile);
            }
          }
          return true;
        }
        
        return false;
      };
      
      ts.forEachChild(sourceFile, node => {
        if (findType(node)) return;
        ts.forEachChild(node, findType);
      });
    }
    // Check for inline type literal (e.g., { prop1: string; prop2: number })
    else if (ts.isTypeLiteralNode(typeNode)) {
      this.extractPropsFromTypeLiteral(typeNode, propTypes, sourceFile);
    }
  }
  
  // Extract props from interface declaration
  private extractPropsFromInterface(
    node: ts.InterfaceDeclaration,
    propTypes: Map<string, { type: string; required: boolean; description: string }>,
    sourceFile: ts.SourceFile
  ) {
    // Process members
    for (const member of node.members) {
      if (ts.isPropertySignature(member)) {
        const propName = member.name.getText(sourceFile);
        const required = !member.questionToken;
        
        let type = "unknown";
        if (member.type) {
          type = member.type.getText(sourceFile);
        }
        
        // Extract JSDoc comment if any
        let description = "";
        const jsDoc = ts.getJSDocCommentsAndTags(member);
        if (jsDoc && jsDoc.length > 0) {
          const docComment = jsDoc[0];
          if (ts.isJSDoc(docComment) && docComment.comment) {
            description = typeof docComment.comment === 'string' ?
              docComment.comment :
              docComment.comment.map(c => c.text).join('');
          }
        }
        
        propTypes.set(propName, { type, required, description });
      }
    }
    
    // Process extended interfaces
    if (node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          for (const type of clause.types) {
            const extendedType = type.expression.getText(sourceFile);
            
            // Find the extended interface
            const findExtendedInterface = (searchNode: ts.Node) => {
              if (
                ts.isInterfaceDeclaration(searchNode) &&
                searchNode.name.getText(sourceFile) === extendedType
              ) {
                this.extractPropsFromInterface(searchNode, propTypes, sourceFile);
                return true;
              }
              return false;
            };
            
            ts.forEachChild(sourceFile, searchNode => {
              if (findExtendedInterface(searchNode)) return;
              ts.forEachChild(searchNode, findExtendedInterface);
            });
          }
        }
      }
    }
  }
  
  // Extract props from type literal
  private extractPropsFromTypeLiteral(
    node: ts.TypeLiteralNode,
    propTypes: Map<string, { type: string; required: boolean; description: string }>,
    sourceFile: ts.SourceFile
  ) {
    for (const member of node.members) {
      if (ts.isPropertySignature(member)) {
        const propName = member.name.getText(sourceFile);
        const required = !member.questionToken;
        
        let type = "unknown";
        if (member.type) {
          type = member.type.getText(sourceFile);
        }
        
        // Extract JSDoc comment if any
        let description = "";
        const jsDoc = ts.getJSDocCommentsAndTags(member);
        if (jsDoc && jsDoc.length > 0) {
          const docComment = jsDoc[0];
          if (ts.isJSDoc(docComment) && docComment.comment) {
            description = typeof docComment.comment === 'string' ?
              docComment.comment :
              docComment.comment.map(c => c.text).join('');
          }
        }
        
        propTypes.set(propName, { type, required, description });
      }
    }
  }
  
  // Extract props from usage within component
  private extractPropsFromUsage(
    node: ts.Node,
    propsName: string,
    propTypes: Map<string, { type: string; required: boolean; description: string }>,
    sourceFile: ts.SourceFile
  ) {
    const visit = (visitNode: ts.Node) => {
      // Look for property access expressions like props.something
      if (
        ts.isPropertyAccessExpression(visitNode) &&
        visitNode.expression.getText(sourceFile) === propsName
      ) {
        const propName = visitNode.name.getText(sourceFile);
        
        // Skip if we already know this prop
        if (propTypes.has(propName)) {
          ts.forEachChild(visitNode, visit);
          return;
        }
        
        // Try to infer type from context
        let type = "unknown";
        let required = true; // Assume required by default
        
        // Check if used in conditional rendering with ? (might be optional)
        let current = visitNode;
        while (current.parent) {
          if (
            ts.isConditionalExpression(current.parent) &&
            current.parent.condition === current
          ) {
            required = false;
            break;
          }
          
          // Check for && operator in JSX
          if (
            ts.isBinaryExpression(current.parent) &&
            current.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
            current.parent.left === current
          ) {
            required = false;
            break;
          }
          
          // Check for || operator for default values
          if (
            ts.isBinaryExpression(current.parent) &&
            current.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
            current.parent.left === current
          ) {
            required = false;
            break;
          }
          
          // Use a more specific type assertion
          if (current.parent) {
            current = current.parent as ts.PropertyAccessExpression;
          } else {
            break;
          }
        }
        
        // Infer type based on usage context
        type = this.inferTypeFromUsageContext(visitNode, sourceFile) || type;
        
        // Add to props
        propTypes.set(propName, { type, required, description: "" });
      }
      
      // Check for destructuring
      if (
        ts.isVariableDeclaration(visitNode) &&
        ts.isObjectBindingPattern(visitNode.name)
      ) {
        // Check if destructuring from props
        if (
          visitNode.initializer &&
          visitNode.initializer.getText(sourceFile) === propsName
        ) {
          // Process each binding element
          for (const element of visitNode.name.elements) {
            if (ts.isBindingElement(element)) {
              const propName =
                element.propertyName?.getText(sourceFile) || element.name.getText(sourceFile);
              
              // Skip if we already know this prop
              if (propTypes.has(propName)) continue;
              
              // Get the variable name after destructuring
              const varName = element.name.getText(sourceFile);
              
              // Check for default value (indicates optional prop)
              const required = !element.initializer;
              
              // Add to props with unknown type for now
              propTypes.set(propName, { type: "unknown", required, description: "" });
              
              // Try to infer type by tracking how the variable is used
              this.inferTypeFromVariableUsage(node, varName, propName, propTypes, sourceFile);
            }
          }
        }
      }
      
      ts.forEachChild(visitNode, visit);
    };
    
    visit(node);
  }
  
  // Infer type from how a prop is used in context
  private inferTypeFromUsageContext(node: ts.Node, sourceFile: ts.SourceFile): string | null {
    let parent = node.parent;
    
    // Used in JSX attribute
    if (ts.isJsxAttribute(parent)) {
      return "ReactNode";
    }
    
    // Used in comparison
    if (
      ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(parent.operatorToken.kind)
    ) {
      // Compare with true/false
      if (
        (parent.left === node &&
          (parent.right.getText(sourceFile) === "true" ||
            parent.right.getText(sourceFile) === "false")) ||
        (parent.right === node &&
          (parent.left.getText(sourceFile) === "true" ||
            parent.left.getText(sourceFile) === "false"))
      ) {
        return "boolean";
      }
      
      // Compare with number
      if (
        (parent.left === node && !isNaN(Number(parent.right.getText(sourceFile)))) ||
        (parent.right === node && !isNaN(Number(parent.left.getText(sourceFile))))
      ) {
        return "number";
      }
      
      // Compare with string
      if (
        (parent.left === node && ts.isStringLiteral(parent.right)) ||
        (parent.right === node && ts.isStringLiteral(parent.left))
      ) {
        return "string";
      }
    }
    
    // Used in conditional
    if (ts.isConditionalExpression(parent) && parent.condition === node) {
      return "boolean";
    }
    
    // Used in logical expression
    if (
      ts.isBinaryExpression(parent) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(
        parent.operatorToken.kind
      ) &&
      parent.left === node
    ) {
      return "boolean";
    }
    
    // Used in arithmetic
    if (
      ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
      ].includes(parent.operatorToken.kind)
    ) {
      // String concatenation or numeric operation
      if (parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        // If other operand is string, likely string
        if (
          (parent.left === node && ts.isStringLiteral(parent.right)) ||
          (parent.right === node && ts.isStringLiteral(parent.left))
        ) {
          return "string";
        }
      }
      
      return "number";
    }
    
    // Used as function
    if (ts.isCallExpression(parent) && parent.expression === node) {
      return "(...args: any[]) => any";
    }
    
    // Accessing properties (likely object)
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      return "Record<string, unknown>";
    }
    
    // Array access
    if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      return "unknown[]";
    }
    
    // JSX spread attributes
    if (ts.isJsxSpreadAttribute(parent)) {
      return "Record<string, unknown>";
    }
    
    // Object spread
    if (ts.isSpreadAssignment(parent)) {
      return "Record<string, unknown>";
    }
    
    return null;
  }
  
  // Infer type by tracking how a destructured variable is used
  private inferTypeFromVariableUsage(
    node: ts.Node,
    varName: string,
    propName: string,
    propTypes: Map<string, { type: string; required: boolean; description: string }>,
    sourceFile: ts.SourceFile
  ) {
    const visit = (visitNode: ts.Node) => {
      // Skip nodes before the variable declaration
      if (visitNode.pos < node.pos) {
        return;
      }
      
      // Check for direct usage of the variable
      if (ts.isIdentifier(visitNode) && visitNode.getText(sourceFile) === varName) {
        // Get inferred type from context
        const inferredType = this.inferTypeFromUsageContext(visitNode, sourceFile);
        
        if (inferredType) {
          // Update prop type
          const prop = propTypes.get(propName);
          if (prop && prop.type === "unknown") {
            propTypes.set(propName, { ...prop, type: inferredType });
            return; // Found a good type, stop searching
          }
        }
      }
      
      ts.forEachChild(visitNode, visit);
    };
    
    // Start tracking from the parent of the variable declaration
    let parent = node.parent;
    while (parent) {
      if (ts.isBlock(parent) || ts.isFunctionDeclaration(parent) || ts.isArrowFunction(parent)) {
        break;
      }
      parent = parent.parent;
    }
    
    if (parent) {
      visit(parent);
    }
  }
  
  // Analyze props of a class component
  private analyzeClassComponentProps(
    node: ts.ClassDeclaration,
    propTypes: Map<string, { type: string; required: boolean; description: string }>,
    sourceFile: ts.SourceFile
  ) {
    // Look for prop type definitions
    // Check heritage clauses (extends React.Component<Props, State>)
    if (node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        for (const type of clause.types) {
          const expression = type.expression.getText(sourceFile);
          
          // Check if extends React.Component or Component
          if (expression.includes("Component")) {
            // Check for type arguments
            if (type.typeArguments && type.typeArguments.length > 0) {
              const propsType = type.typeArguments[0];
              this.extractPropsFromTypeAnnotation(propsType, propTypes, sourceFile);
            }
          }
        }
      }
    }
    
    // Check for this.props usage in methods
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) && member.body) {
        const method = member.name.getText(sourceFile);
        
        // Skip certain lifecycle methods for efficiency
        if (["componentDidCatch", "getDerivedStateFromError"].includes(method)) {
          continue;
        }
        
        // Process method body
        this.extractPropsFromClassMethod(member.body, propTypes, sourceFile);
      }
    }
  }
  
  // Extract props usage from class component method
  private extractPropsFromClassMethod(
    node: ts.Node,
    propTypes: Map<string, { type: string; required: boolean; description: string }>,
    sourceFile: ts.SourceFile
  ) {
    const visit = (visitNode: ts.Node) => {
      // Look for this.props.something
      if (
        ts.isPropertyAccessExpression(visitNode) &&
        visitNode.expression.getText(sourceFile).includes("this.props")
      ) {
        const propName = visitNode.name.getText(sourceFile);
        
        // Skip if we already know this prop
        if (propTypes.has(propName)) {
          ts.forEachChild(visitNode, visit);
          return;
        }
        
        // Try to infer type from context
        let type = "unknown";
        let required = true; // Assume required by default
        
        // Check if used in conditional (might be optional)
        let current = visitNode;
        while (current.parent) {
          if (
            ts.isConditionalExpression(current.parent) &&
            current.parent.condition === current
          ) {
            required = false;
            break;
          }
          
          // Check for && operator in JSX
          if (
            ts.isBinaryExpression(current.parent) &&
            current.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
            current.parent.left === current
          ) {
            required = false;
            break;
          }
          
          // Use a more specific type assertion
          if (current.parent) {
            current = current.parent as ts.PropertyAccessExpression;
          } else {
            break;
          }
        }
        
        // Infer type based on usage context
        type = this.inferTypeFromUsageContext(visitNode, sourceFile) || type;
        
        // Add to props
        propTypes.set(propName, { type, required, description: "" });
      }
      
      // Check for destructuring
      if (
        ts.isVariableDeclaration(visitNode) &&
        ts.isObjectBindingPattern(visitNode.name)
      ) {
        // Check if destructuring from this.props
        if (
          visitNode.initializer &&
          visitNode.initializer.getText(sourceFile).includes("this.props")
        ) {
          // Process each binding element
          for (const element of visitNode.name.elements) {
            if (ts.isBindingElement(element)) {
              const propName =
                element.propertyName?.getText(sourceFile) || element.name.getText(sourceFile);
              
              // Skip if we already know this prop
              if (propTypes.has(propName)) continue;
              
              // Get the variable name after destructuring
              const varName = element.name.getText(sourceFile);
              
              // Check for default value (indicates optional prop)
              const required = !element.initializer;
              
              // Add to props with unknown type for now
              propTypes.set(propName, { type: "unknown", required, description: "" });
              
              // Try to infer type by tracking how the variable is used
              this.inferTypeFromVariableUsage(node, varName, propName, propTypes, sourceFile);
            }
          }
        }
      }
      
      ts.forEachChild(visitNode, visit);
    };
    
    visit(node);
  }
  
  // Generate interface code
  private generateInterfaceCode(
    componentName: string,
    propTypes: Map<string, { type: string; required: boolean; description: string }>
  ): string {
    const lines: string[] = [
      `/**`,
      ` * Props for the ${componentName} component`,
      ` */`,
      `interface ${componentName}Props {`,
    ];
    
    // Add props
    for (const [name, info] of propTypes.entries()) {
      // Add description if available
      if (info.description) {
        lines.push(`  /**`);
        lines.push(`   * ${info.description}`);
        lines.push(`   */`);
      }
      
      // Add prop with optional ? if needed
      lines.push(`  ${name}${info.required ? "" : "?"}: ${info.type};`);
    }
    
    lines.push(`}`);
    lines.push(``);
    
    // For React components, also add a DefaultProps type
    lines.push(`/**`);
    lines.push(` * Default props for the ${componentName} component`);
    lines.push(` */`);
    lines.push(`type ${componentName}DefaultProps = Partial<${componentName}Props>;`);
    
    return lines.join("\n");
  }
}

// =============================================================================
// Batch Processing System
// =============================================================================

// Batch processor for handling multiple files
class BatchProcessor {
  private logger: pino.Logger;
  private analyzer: TypeScriptAnalyzerService;
  private fs: FileSystemService;
  private config: Config;
  
  constructor(
    config: Config,
    logger: pino.Logger,
    analyzer: TypeScriptAnalyzerService,
    fs: FileSystemService
  ) {
    this.config = config;
    this.logger = logger.child({ component: "batch" });
    this.analyzer = analyzer;
    this.fs = fs;
  }
  
  // Process multiple files with progress reporting
  async processFiles(
    files: string[],
    operation: "analyze" | "fix",
    options: {
      fixType?: string;
      dryRun?: boolean;
      onProgress?: (processed: number, total: number, currentFile: string) => void;
    } = {}
  ): Promise<BatchResult> {
    const {
      fixType = this.config.fix.defaultReplacement,
      dryRun = false,
      onProgress,
    } = options;
    
    const total = files.length;
    let processed = 0;
    let successful = 0;
    let failed = 0;
    const results: Array<AnalysisResult | FixResult> = [];
    const errors: Array<{ file: string; error: string }> = [];
    
    this.logger.info(
      { operation, total, options },
      `Starting batch ${operation} operation on ${total} files`
    );
    
    // Process files in chunks to control concurrency
    const concurrency = this.config.batch.concurrency;
    let currentPosition = 0;
    
    // Process a chunk of files
    const processChunk = async () => {
      const chunkFiles = files.slice(currentPosition, currentPosition + concurrency);
      currentPosition += concurrency;
      
      if (chunkFiles.length === 0) return;
      
      // Process each file in the chunk concurrently
      await Promise.all(
        chunkFiles.map(async file => {
          try {
            let result;
            
            if (operation === "analyze") {
              result = await this.analyzer.analyzeFile(file);
            } else {
              result = await this.analyzer.fixFile(file, { fixType, dryRun });
            }
            
            results.push(result);
            successful++;
          } catch (error) {
            this.logger.error(
              { error, file },
              `Error during batch ${operation} operation`
            );
            
            errors.push({
              file,
              error: error.message,
            });
            
            failed++;
          }
          
          // Update progress
          processed++;
          if (onProgress && this.config.batch.progressReporting) {
            onProgress(processed, total, file);
          }
        })
      );
      
      // Process next chunk if there are more files
      if (currentPosition < files.length) {
        return processChunk();
      }
    };
    
    // Start processing
    await processChunk();
    
    const result: BatchResult = {
      success: failed === 0,
      operation,
      totalFiles: total,
      processedFiles: processed,
      successfulFiles: successful,
      failedFiles: failed,
      results,
      errors,
    };
    
    this.logger.info(
      {
        operation,
        total,
        processed,
        successful,
        failed,
      },
      `Batch ${operation} operation completed`
    );
    
    return result;
  }
}

// =============================================================================
// MCP Tool Handlers
// =============================================================================

// Result types
interface AnalysisResult {
  success: boolean;
  filePath: string;
  patterns: Array<{
    pattern: string;
    line: number;
    character: number;
    suggestion: string;
    nodeKind?: ts.SyntaxKind;
    parentKind?: ts.SyntaxKind;
    context?: string;
  }>;
  totalPatterns: number;
  fileHash?: string;
  error?: string;
}

interface FixChange {
  start: number;
  end: number;
  original: string;
  replacement: string;
  line: number;
  character: number;
  pattern: string;
}

interface FixResult {
  success: boolean;
  filePath: string;
  changes: FixChange[];
  totalChanges: number;
  appliedChanges: boolean;
  backupCreated: boolean;
  backupPath: string;
  error?: string;
}

interface BatchResult {
  success: boolean;
  operation: "analyze" | "fix";
  totalFiles: number;
  processedFiles: number;
  successfulFiles: number;
  failedFiles: number;
  results: Array<AnalysisResult | FixResult>;
  errors: Array<{ file: string; error: string }>;
}

interface ComponentInterfaceResult {
  success: boolean;
  component: string;
  componentType?: "function" | "class" | "arrow" | "memo";
  interface?: string;
  props?: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  writtenToFile?: boolean;
  outputPath?: string;
  error?: string;
  filePath: string;
}

// Helper functions
function calculateHash(data: string): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

// =============================================================================
// Main Application
// =============================================================================

// Create and configure services
async function createServices(configPath?: string) {
  // Load configuration
  const config = loadConfig(configPath);
  
  // Create logger
  const logger = createLogger(config);
  
  // Create cache service
  const cache = new CacheService(config, logger);
  
  // Create file system service
  const fs = new FileSystemService(config, logger);
  
  // Create analyzer service
  const analyzer = new TypeScriptAnalyzerService(config, logger, cache, fs);
  
  // Create batch processor
  const batch = new BatchProcessor(config, logger, analyzer, fs);
  
  return {
    config,
    logger,
    cache,
    fs,
    analyzer,
    batch,
  };
}

// Main entry point
async function main() {
  // Create services
  const services = await createServices();
  const { config, logger, analyzer, batch, fs } = services;
  
  // Create MCP server
  const server = new McpServer({
    name: config.server.name,
    version: config.server.version,
    description: config.server.description,
  });
  
  // Register tool: Get server info
  server.tool(
    "getServerInfo",
    {},
    async () => {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            name: config.server.name,
            version: config.server.version,
            description: config.server.description,
            features: [
              "TypeScript 'any' type analysis and fixing",
              "React component props interface generation",
              "Intelligent type inference",
              "Batch processing",
              "File caching for performance",
            ],
            configuration: config,
          }, null, 2)
        }]
      };
    }
  );
  
  // Register tool: Configure server
  server.tool(
    "configureServer",
    {
      config: z.object({}).passthrough().describe("Configuration object (partial)")
    },
    async (params) => {
      try {
        // Validate and merge with current config
        const newConfig = ConfigSchema.parse(deepMerge(config, params.config));
        
        // Update config
        Object.assign(config, newConfig);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Configuration updated",
              config: newConfig,
            }, null, 2)
          }]
        };
      } catch (error) {
        logger.error({ error }, "Configuration update failed");
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: `Configuration error: ${error.message}`,
            }, null, 2)
          }]
        };
      }
    }
  );
  
  // Register tool: Analyze a TypeScript file
  server.tool(
    "analyzeTypeScriptFile",
    {
      filePath: z.string().describe("Path to the TypeScript file to analyze"),
      skipCache: z.boolean().optional().default(false).describe("If true, skip using cached results")
    },
    async (params) => {
      const { filePath, skipCache = false } = params;
      
      try {
        // Disable cache temporarily if requested
        const cacheEnabled = config.analysis.cacheEnabled;
        if (skipCache) {
          config.analysis.cacheEnabled = false;
        }
        
        // Analyze file
        const result = await analyzer.analyzeFile(filePath);
        
        // Restore cache setting
        config.analysis.cacheEnabled = cacheEnabled;
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        logger.error({ error, filePath }, "Analysis failed");
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              filePath,
              error: `Error analyzing file: ${error.message}`,
            }, null, 2)
          }]
        };
      }
    }
  );
  
  // Register tool: Fix 'any' types in a TypeScript file
  server.tool(
    "fixTypeScriptFile",
    {
      filePath: z.string().describe("Path to the TypeScript file to fix"),
      fixType: z.enum(["unknown", "Record<string, unknown>", "object"]).optional().describe("Default type to use for replacement"),
      dryRun: z.boolean().optional().describe("If true, show changes without applying them"),
      skipBackup: z.boolean().optional().describe("If true, don't create backup before fixing")
    },
    async (params) => {
      const {
        filePath,
        fixType = config.fix.defaultReplacement,
        dryRun = false,
        skipBackup = false,
      } = params;
      
      try {
        // Temporarily disable backups if requested
        const createBackups = config.fix.createBackups;
        if (skipBackup) {
          config.fix.createBackups = false;
        }
        
        // Fix file
        const result = await analyzer.fixFile(filePath, { fixType, dryRun });
        
        // Restore backup setting
        config.fix.createBackups = createBackups;
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        logger.error({ error, filePath }, "Fix failed");
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              filePath,
              error: `Error fixing file: ${error.message}`,
            }, null, 2)
          }]
        };
      }
    }
  );
  
  // Register tool: Batch fix multiple TypeScript files
  server.tool(
    "batchFixTypeScriptFiles",
    {
      directory: z.string().describe("Directory containing TypeScript files"),
      pattern: z.string().optional().default("**/*.{ts,tsx}").describe("Glob pattern for files to process"),
      fixType: z.enum(["unknown", "Record<string, unknown>", "object"]).optional().default("unknown").describe("Default type to use for replacement"),
      dryRun: z.boolean().optional().default(false).describe("If true, show changes without applying them"),
      concurrency: z.number().optional().describe("Number of files to process concurrently")
    },
    async (params) => {
      const {
        directory,
        pattern = "**/*.{ts,tsx}",
        fixType = config.fix.defaultReplacement,
        dryRun = false,
        concurrency,
      } = params;
      
      try {
        // Override concurrency if specified
        if (concurrency !== undefined) {
          config.batch.concurrency = concurrency;
        }
        
        // Find files matching pattern
        const files = fs.findFiles(directory, pattern);
        
        if (files.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `No files matching pattern ${pattern} found in ${directory}`,
                totalFiles: 0,
                processedFiles: 0,
              }, null, 2)
            }]
          };
        }
        
        // Set up progress callback
        let lastProgressReport = Date.now();
        let progressMessage = "";
        
        const onProgress = (processed: number, total: number, currentFile: string) => {
          const now = Date.now();
          
          // Throttle progress updates
          if (now - lastProgressReport >= config.batch.progressInterval) {
            const percent = Math.round((processed / total) * 100);
            progressMessage = `Processing file ${processed}/${total} (${percent}%): ${path.basename(
              currentFile
            )}`;
            lastProgressReport = now;
            
            // In a real implementation, you would have a way to report progress to the client
            logger.debug(
              { processed, total, percent, file: currentFile },
              "Batch progress"
            );
          }
        };
        
        // Process files
        const result = await batch.processFiles(files, "fix", {
          fixType,
          dryRun,
          onProgress,
        });
        
        const resultWithProgress = {
          ...result,
          progressMessage,
        };
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(resultWithProgress, null, 2)
          }]
        };
      } catch (error) {
        logger.error({ error, directory }, "Batch fix failed");
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: `Error in batch fix: ${error.message}`,
            }, null, 2)
          }]
        };
      }
    }
  );
  
  // Register tool: Generate React component props interface
  server.tool(
    "generateComponentInterface",
    {
      filePath: z.string().describe("Path to the React component file"),
      componentName: z.string().describe("Name of the component to analyze"),
      outputPath: z.string().optional().describe("Path where to save the generated interface (optional)")
    },
    async (params) => {
      const { filePath, componentName, outputPath } = params;
      
      try {
        const result = await analyzer.generateComponentInterface(filePath, componentName, outputPath);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        logger.error({ error, filePath, componentName }, "Component interface generation failed");
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              component: componentName,
              filePath,
              error: `Error generating component interface: ${error.message}`,
            }, null, 2)
          }]
        };
      }
    }
  );
  
  // Register tool: Clear analysis cache
  server.tool(
    "clearCache",
    {},
    async () => {
      try {
        services.cache.clear();
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Cache cleared successfully",
            }, null, 2)
          }]
        };
      } catch (error) {
        logger.error({ error }, "Cache clear failed");
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: `Error clearing cache: ${error.message}`,
            }, null, 2)
          }]
        };
      }
    }
  );
  
  // Start the server
  logger.info(
    { name: config.server.name, version: config.server.version },
    "Starting TypeScript Analyzer MCP Server..."
  );
  
  // Connect to stdio for communication
  const transport = new StdioServerTransport();
  
  try {
    // Connect and start the server
    await server.connect(transport);
    logger.info("Server started successfully");
  } catch (error) {
    logger.fatal({ error }, "Error starting server");
    process.exit(1);
  }
}

main();
