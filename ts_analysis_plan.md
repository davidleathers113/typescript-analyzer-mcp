# TypeScript Analysis Plan: MCP vs Command-Line Approaches

This document outlines a comprehensive plan to analyze TypeScript `any` type usage in the project at `/Users/davidleathers/fCMO-Website/conversion-genesis-architect/` using two different approaches, and then comparing the results.

## 1. Setup and Configuration

### MCP Server Setup
1. Clone the TypeScript Analyzer MCP Server to a local directory
2. Install dependencies: `npm install`
3. Build the project: `npm run build`
4. Configure Claude Desktop to use the MCP server:
   ```json
   {
     "mcpServers": {
       "typescript-analyzer": {
         "command": "node",
         "args": ["/path/to/typescript-analyzer-mcp/dist/index.js"],
         "env": {}
       }
     }
   }
   ```

### Command-Line Environment Setup
1. Ensure Node.js and npm are installed
2. Install global dependencies:
   ```bash
   npm install -g typescript ts-node eslint
   ```
3. Set up a directory for storing analysis results:
   ```bash
   mkdir -p analysis-results/mcp-results
   mkdir -p analysis-results/cmd-results
   ```

## 2. MCP Tool Approach

### Step 1: Project-Wide Scan
Use the `batchFixTypeScriptFiles` tool with `dryRun: true` to scan all TypeScript files:
```
Please use the typescript-analyzer to scan all TypeScript files in /Users/davidleathers/fCMO-Website/conversion-genesis-architect/ with a dry run (no changes applied)
```

### Step 2: Component-by-Component Analysis
Analyze key components to identify patterns:
```
Please analyze the file /Users/davidleathers/fCMO-Website/conversion-genesis-architect/src/components/About.tsx
```

Repeat for other key components identified in the project structure.

### Step 3: React Hook Analysis
Specifically target the React hooks issues:
```
Please analyze all files in /Users/davidleathers/fCMO-Website/conversion-genesis-architect/src/hooks/ for React hook dependency issues
```

### Step 4: Generate Interfaces for Common Components
```
Please generate interfaces for components with 'any' props in /Users/davidleathers/fCMO-Website/conversion-genesis-architect/src/components/admin/
```

### Step 5: Collect Results
Record all findings from the MCP server in a structured format for later comparison.

## 3. Command-Line Approach

### Step 1: ESLint Analysis
```bash
npx eslint --format json "/Users/davidleathers/fCMO-Website/conversion-genesis-architect/src/**/*.{ts,tsx}" > analysis-results/cmd-results/eslint-output.json
```

### Step 2: TypeScript Compiler Analysis
```bash
cd /Users/davidleathers/fCMO-Website/conversion-genesis-architect/ && \
npx tsc --noEmit --project tsconfig.json > analysis-results/cmd-results/tsc-errors.txt
```

### Step 3: Pattern Scanning with grep/find
Scan for `any` types:
```bash
find /Users/davidleathers/fCMO-Website/conversion-genesis-architect/src -name "*.ts*" | xargs grep -l ": any" > analysis-results/cmd-results/any-files.txt
```

Count occurrences per file:
```bash
find /Users/davidleathers/fCMO-Website/conversion-genesis-architect/src -name "*.ts*" | xargs grep -c ": any" > analysis-results/cmd-results/any-counts.txt
```

### Step 4: React Hook Analysis
Scan for React hook dependency warnings:
```bash
find /Users/davidleathers/fCMO-Website/conversion-genesis-architect/src -name "*.ts*" | xargs grep -l "React Hook useEffect has a missing dependency" > analysis-results/cmd-results/hook-dep-files.txt
```

### Step 5: Type Pattern Analysis with Custom Script
Create and run a custom script to analyze type patterns:

```bash
# Create script
cat > analyze-patterns.js << 'EOF'
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

// Configuration
const PROJECT_ROOT = '/Users/davidleathers/fCMO-Website/conversion-genesis-architect/';
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const RESULTS_FILE = path.join(process.cwd(), 'analysis-results/cmd-results/type-patterns.json');

// Track patterns
const anyUsagePatterns = new Map();
const anyContextPatterns = new Map();

function scanFile(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      fileContent,
      ts.ScriptTarget.Latest,
      true
    );
    
    function visit(node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const parent = node.parent;
        
        if (parent) {
          let pattern = '';
          let context = '';
          
          if (ts.isParameter(parent)) {
            const paramName = parent.name.getText(sourceFile);
            pattern = `${paramName}: any`;
            context = 'function-parameter';
          } 
          else if (ts.isPropertySignature(parent)) {
            const propName = parent.name.getText(sourceFile);
            pattern = `${propName}: any`;
            context = 'interface-property';
          }
          else if (ts.isTypeReference(parent)) {
            pattern = `${parent.getText(sourceFile)}`;
            context = 'type-reference';
          }
          else if (ts.isArrayTypeNode(parent)) {
            pattern = 'any[]';
            context = 'array-type';
          }
          
          // Count occurrences
          anyUsagePatterns.set(pattern, (anyUsagePatterns.get(pattern) || 0) + 1);
          
          // Track file contexts for this pattern
          if (!anyContextPatterns.has(pattern)) {
            anyContextPatterns.set(pattern, new Set());
          }
          anyContextPatterns.get(pattern).add(
            path.relative(PROJECT_ROOT, filePath)
          );
        }
      }
      
      ts.forEachChild(node, visit);
    }
    
    visit(sourceFile);
  } catch (error) {
    console.error(`Error scanning ${filePath}:`, error.message);
  }
}

// Get all TypeScript files
function getAllTsFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  
  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      // Recursively scan subdirectories, but skip node_modules
      if (file !== 'node_modules') {
        results = results.concat(getAllTsFiles(filePath));
      }
    } else if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      results.push(filePath);
    }
  });
  
  return results;
}

// Main execution
console.log('Scanning TypeScript files...');
const files = getAllTsFiles(SRC_DIR);
console.log(`Found ${files.length} TypeScript files to scan`);

files.forEach((file, index) => {
  if (index % 50 === 0) {
    console.log(`Progress: ${index}/${files.length} files scanned`);
  }
  scanFile(file);
});

// Convert results to serializable format
const results = {
  patterns: {},
  contexts: {}
};

anyUsagePatterns.forEach((count, pattern) => {
  results.patterns[pattern] = count;
});

anyContextPatterns.forEach((files, pattern) => {
  results.contexts[pattern] = Array.from(files);
});

// Save results
fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
console.log(`Results saved to ${RESULTS_FILE}`);
EOF

# Run the script
node analyze-patterns.js
```

### Step 6: React Component Analysis with Custom Script

```bash
# Create script
cat > analyze-components.js << 'EOF'
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

// Configuration
const PROJECT_ROOT = '/Users/davidleathers/fCMO-Website/conversion-genesis-architect/';
const SRC_DIR = path.join(PROJECT_ROOT, 'src/components');
const RESULTS_FILE = path.join(process.cwd(), 'analysis-results/cmd-results/component-analysis.json');

// Track component props
const componentProps = new Map();

function analyzeComponent(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      fileContent,
      ts.ScriptTarget.Latest,
      true
    );
    
    function visit(node) {
      // Look for variable declarations that might be components
      if (ts.isVariableDeclaration(node) && 
          node.initializer && 
          ts.isArrowFunction(node.initializer)) {
        
        const componentName = node.name.getText(sourceFile);
        
        // Check if it has any props parameter
        const parameters = node.initializer.parameters;
        if (parameters.length > 0) {
          const propsParam = parameters[0];
          
          // Check if props is typed as any
          if (propsParam.type && 
              propsParam.type.kind === ts.SyntaxKind.AnyKeyword) {
            
            // Track component
            if (!componentProps.has(componentName)) {
              componentProps.set(componentName, {
                file: path.relative(PROJECT_ROOT, filePath),
                props: new Set()
              });
            }
            
            // Find props usage
            if (node.initializer.body) {
              const extractPropsUsage = (n) => {
                if (ts.isPropertyAccessExpression(n) && 
                    n.expression.getText(sourceFile) === propsParam.name.getText(sourceFile)) {
                  
                  const propName = n.name.getText(sourceFile);
                  componentProps.get(componentName).props.add(propName);
                }
                
                ts.forEachChild(n, extractPropsUsage);
              };
              
              ts.forEachChild(node.initializer.body, extractPropsUsage);
            }
          }
        }
      }
      
      ts.forEachChild(node, visit);
    }
    
    visit(sourceFile);
  } catch (error) {
    console.error(`Error analyzing ${filePath}:`, error.message);
  }
}

// Get all TypeScript files
function getAllTsFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  
  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      results = results.concat(getAllTsFiles(filePath));
    } else if (filePath.endsWith('.tsx')) {
      results.push(filePath);
    }
  });
  
  return results;
}

// Main execution
console.log('Analyzing React components...');
const files = getAllTsFiles(SRC_DIR);
console.log(`Found ${files.length} component files to analyze`);

files.forEach((file, index) => {
  if (index % 20 === 0) {
    console.log(`Progress: ${index}/${files.length} files analyzed`);
  }
  analyzeComponent(file);
});

// Convert results to serializable format
const results = {};

componentProps.forEach((data, componentName) => {
  results[componentName] = {
    file: data.file,
    props: Array.from(data.props)
  };
});

// Save results
fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
console.log(`Results saved to ${RESULTS_FILE}`);
EOF

# Run the script
node analyze-components.js
```

## 4. Comparison and Analysis

### Step 1: Generate Summary Statistics
Create a script to compare the results from both approaches:

```bash
# Create comparison script
cat > compare-results.js << 'EOF'
const fs = require('fs');
const path = require('path');

const CMD_RESULTS_DIR = path.join(process.cwd(), 'analysis-results/cmd-results');
const MCP_RESULTS_DIR = path.join(process.cwd(), 'analysis-results/mcp-results');
const COMPARISON_FILE = path.join(process.cwd(), 'analysis-results/comparison.json');

// Load command-line results
const cmdEslintOutput = require(path.join(CMD_RESULTS_DIR, 'eslint-output.json'));
const cmdTypePatterns = require(path.join(CMD_RESULTS_DIR, 'type-patterns.json'));
const cmdComponentAnalysis = require(path.join(CMD_RESULTS_DIR, 'component-analysis.json'));

// Load MCP results
const mcpResults = require(path.join(MCP_RESULTS_DIR, 'mcp-results.json'));

// Compare the results
const comparison = {
  summary: {
    totalAnyTypes: {
      commandLine: Object.values(cmdTypePatterns.patterns).reduce((sum, count) => sum + count, 0),
      mcp: mcpResults.summary.totalAnyTypes
    },
    filesWithAnyTypes: {
      commandLine: Object.keys(cmdEslintOutput.reduce((acc, file) => {
        if (file.messages.some(msg => msg.ruleId === '@typescript-eslint/no-explicit-any')) {
          acc[file.filePath] = true;
        }
        return acc;
      }, {})).length,
      mcp: mcpResults.summary.filesWithAnyTypes
    },
    componentsWithAnyProps: {
      commandLine: Object.keys(cmdComponentAnalysis).length,
      mcp: mcpResults.summary.componentsWithAnyProps
    },
    topPatterns: {
      commandLine: Object.entries(cmdTypePatterns.patterns)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([pattern, count]) => ({ pattern, count })),
      mcp: mcpResults.summary.topPatterns
    }
  },
  accuracy: {
    // Calculate agreement percentage between the two approaches
    anyTypesCountDifference: Math.abs(
      Object.values(cmdTypePatterns.patterns).reduce((sum, count) => sum + count, 0) - 
      mcpResults.summary.totalAnyTypes
    ),
    componentDetectionAgreement: {
      // Calculate overlap in component detection
      commandLineOnly: Object.keys(cmdComponentAnalysis).filter(
        component => !mcpResults.components.includes(component)
      ),
      mcpOnly: mcpResults.components.filter(
        component => !Object.keys(cmdComponentAnalysis).includes(component)
      ),
      both: Object.keys(cmdComponentAnalysis).filter(
        component => mcpResults.components.includes(component)
      )
    }
  },
  performance: {
    // Execution times would be recorded during the actual runs
    commandLineTimeMs: 0, // To be filled in after running
    mcpTimeMs: 0 // To be filled in after running
  }
};

// Save comparison results
fs.writeFileSync(COMPARISON_FILE, JSON.stringify(comparison, null, 2));
console.log(`Comparison saved to ${COMPARISON_FILE}`);
EOF
```

### Step 2: Generate Visualizations
Create charts comparing the two approaches:

```bash
# Create visualization script
cat > generate-charts.js << 'EOF'
const fs = require('fs');
const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const COMPARISON_FILE = path.join(process.cwd(), 'analysis-results/comparison.json');
const CHARTS_DIR = path.join(process.cwd(), 'analysis-results/charts');

// Ensure charts directory exists
if (!fs.existsSync(CHARTS_DIR)) {
  fs.mkdirSync(CHARTS_DIR, { recursive: true });
}

// Load comparison data
const comparison = require(COMPARISON_FILE);

// Create a chart canvas
const width = 800;
const height = 600;
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

// Generate summary chart
async function generateSummaryChart() {
  const configuration = {
    type: 'bar',
    data: {
      labels: ['Total Any Types', 'Files With Any Types', 'Components With Any Props'],
      datasets: [
        {
          label: 'Command Line Approach',
          data: [
            comparison.summary.totalAnyTypes.commandLine,
            comparison.summary.filesWithAnyTypes.commandLine,
            comparison.summary.componentsWithAnyProps.commandLine
          ],
          backgroundColor: 'rgba(54, 162, 235, 0.5)'
        },
        {
          label: 'MCP Approach',
          data: [
            comparison.summary.totalAnyTypes.mcp,
            comparison.summary.filesWithAnyTypes.mcp,
            comparison.summary.componentsWithAnyProps.mcp
          ],
          backgroundColor: 'rgba(255, 99, 132, 0.5)'
        }
      ]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: 'Comparison of Analysis Approaches'
        }
      },
      scales: {
        y: {
          beginAtZero: true
        }
      }
    }
  };

  const image = await chartJSNodeCanvas.renderToBuffer(configuration);
  fs.writeFileSync(path.join(CHARTS_DIR, 'summary-comparison.png'), image);
}

// Generate pattern comparison chart
async function generatePatternChart() {
  // Extract top 5 patterns from each approach
  const cmdPatterns = comparison.summary.topPatterns.commandLine.slice(0, 5);
  const mcpPatterns = comparison.summary.topPatterns.mcp.slice(0, 5);
  
  // Combine and deduplicate patterns
  const allPatterns = [...new Set([
    ...cmdPatterns.map(p => p.pattern),
    ...mcpPatterns.map(p => p.pattern)
  ])];
  
  // Create datasets
  const cmdData = allPatterns.map(pattern => {
    const found = cmdPatterns.find(p => p.pattern === pattern);
    return found ? found.count : 0;
  });
  
  const mcpData = allPatterns.map(pattern => {
    const found = mcpPatterns.find(p => p.pattern === pattern);
    return found ? found.count : 0;
  });
  
  const configuration = {
    type: 'horizontalBar',
    data: {
      labels: allPatterns,
      datasets: [
        {
          label: 'Command Line Approach',
          data: cmdData,
          backgroundColor: 'rgba(54, 162, 235, 0.5)'
        },
        {
          label: 'MCP Approach',
          data: mcpData,
          backgroundColor: 'rgba(255, 99, 132, 0.5)'
        }
      ]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: 'Top "any" Type Patterns'
        }
      },
      scales: {
        x: {
          beginAtZero: true
        }
      }
    }
  };

  const image = await chartJSNodeCanvas.renderToBuffer(configuration);
  fs.writeFileSync(path.join(CHARTS_DIR, 'pattern-comparison.png'), image);
}

// Generate performance chart
async function generatePerformanceChart() {
  const configuration = {
    type: 'bar',
    data: {
      labels: ['Execution Time (ms)'],
      datasets: [
        {
          label: 'Command Line Approach',
          data: [comparison.performance.commandLineTimeMs],
          backgroundColor: 'rgba(54, 162, 235, 0.5)'
        },
        {
          label: 'MCP Approach',
          data: [comparison.performance.mcpTimeMs],
          backgroundColor: 'rgba(255, 99, 132, 0.5)'
        }
      ]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: 'Performance Comparison'
        }
      },
      scales: {
        y: {
          beginAtZero: true
        }
      }
    }
  };

  const image = await chartJSNodeCanvas.renderToBuffer(configuration);
  fs.writeFileSync(path.join(CHARTS_DIR, 'performance-comparison.png'), image);
}

// Run all chart generation
async function generateAllCharts() {
  await generateSummaryChart();
  await generatePatternChart();
  await generatePerformanceChart();
  console.log('All charts generated successfully!');
}

generateAllCharts().catch(console.error);
EOF

# Install dependencies and run
npm install chartjs-node-canvas
node generate-charts.js
```

## 5. Data Collection Execution Plan

### MCP Approach Execution
1. Start timing the MCP approach
2. Execute each MCP tool scan and save results to JSON files
3. Combine results into a single consolidated MCP result file
4. Record execution time

### Command-Line Approach Execution
1. Start timing the command-line approach
2. Execute each command in sequence, saving output to appropriate files
3. Run the analysis scripts to generate structured data
4. Record execution time

## 6. Analysis and Report Generation

### Generate Final Comparison Report

Create a markdown report summarizing the findings:

```bash
cat > generate-report.js << 'EOF'
const fs = require('fs');
const path = require('path');

const COMPARISON_FILE = path.join(process.cwd(), 'analysis-results/comparison.json');
const REPORT_FILE = path.join(process.cwd(), 'analysis-results/final-report.md');
const CHARTS_DIR = path.join(process.cwd(), 'analysis-results/charts');

// Load comparison data
const comparison = require(COMPARISON_FILE);

// Generate report
const report = `# TypeScript Analysis Comparison Report

## Overview

This report compares two approaches to analyzing TypeScript \`any\` types in the project:
1. Using an MCP (Model Context Protocol) server
2. Using command-line tools and custom scripts

## Summary Statistics

| Metric | Command-Line Approach | MCP Approach | Difference |
|--------|----------------------|--------------|------------|
| Total Any Types | ${comparison.summary.totalAnyTypes.commandLine} | ${comparison.summary.totalAnyTypes.mcp} | ${Math.abs(comparison.summary.totalAnyTypes.commandLine - comparison.summary.totalAnyTypes.mcp)} |
| Files With Any Types | ${comparison.summary.filesWithAnyTypes.commandLine} | ${comparison.summary.filesWithAnyTypes.mcp} | ${Math.abs(comparison.summary.filesWithAnyTypes.commandLine - comparison.summary.filesWithAnyTypes.mcp)} |
| Components With Any Props | ${comparison.summary.componentsWithAnyProps.commandLine} | ${comparison.summary.componentsWithAnyProps.mcp} | ${Math.abs(comparison.summary.componentsWithAnyProps.commandLine - comparison.summary.componentsWithAnyProps.mcp)} |

## Top Patterns

### Command-Line Approach
${comparison.summary.topPatterns.commandLine.map((p, i) => `${i+1}. \`${p.pattern}\` (${p.count} occurrences)`).join('\n')}

### MCP Approach
${comparison.summary.topPatterns.mcp.map((p, i) => `${i+1}. \`${p.pattern}\` (${p.count} occurrences)`).join('\n')}

## Agreement Analysis

The approaches agreed on ${comparison.accuracy.componentDetectionAgreement.both.length} components with \`any\` props.

There were ${comparison.accuracy.componentDetectionAgreement.commandLineOnly.length} components detected only by the command-line approach and ${comparison.accuracy.componentDetectionAgreement.mcpOnly.length} components detected only by the MCP approach.

## Performance Comparison

- Command-Line Approach: ${comparison.performance.commandLineTimeMs}ms
- MCP Approach: ${comparison.performance.mcpTimeMs}ms
- Difference: ${Math.abs(comparison.performance.commandLineTimeMs - comparison.performance.mcpTimeMs)}ms

## Visualizations

Charts comparing the two approaches can be found in the \`charts\` directory.

## Conclusion

[To be filled based on actual results]
`;

// Save report
fs.writeFileSync(REPORT_FILE, report);
console.log(`Report saved to ${REPORT_FILE}`);
EOF

node generate-report.js
```

## 7. Expected Outcomes

1. A detailed understanding of TypeScript `any` usage patterns in the project
2. Comparison of tool effectiveness between MCP and command-line approaches
3. Performance benchmarks for each approach
4. Recommendations for which approach to use for ongoing TypeScript analysis
5. A foundation for implementing automated fixes for the identified issues

## 8. Next Steps After Analysis

1. Apply targeted fixes based on the most common patterns identified
2. Implement CI/CD pipeline integration for ongoing type safety monitoring
3. Develop type definitions for frequently used patterns
4. Establish coding standards to prevent future `any` type usage