const github = require("@actions/github");
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const { DiffParser } = require("./diff-parser");
const { shouldAnalyzeFile, severityLevel } = require("./utils");

class CodeReviewBot {
  constructor(config) {
    this.config = config;
    this.octokit = github.getOctokit(config.githubToken);
    this.bedrock = new BedrockRuntimeClient(config.awsConfig);
    this.context = github.context;
    this.diffParser = new DiffParser();
    this.bedrockModelId = config.bedrockModelId;
  }

  async run() {
    if (this.context.eventName === "pull_request") {
      await this.handlePullRequest();
    } else if (this.context.eventName === "issue_comment") {
      await this.handleComment();
    }
  }

  async getPRFiles() {
    const { data: files } = await this.octokit.rest.pulls.listFiles({
      ...this.context.repo,
      pull_number: this.context.payload.pull_request.number,
    });
    return files;
  }

  async handlePullRequest() {
    const files = await this.getPRFiles();
    let analyzedFiles = 0;

    for (const file of files) {
      if (analyzedFiles >= this.config.maxFiles) {
        break;
      }

      if (!shouldAnalyzeFile(file.filename, this.config.excludePatterns)) {
        continue;
      }

      const content = await this.getFileContent(file.filename);
      const analysis = await this.analyzeCode(content, file.filename);
      await this.createReviewComments(file.filename, analysis);
      analyzedFiles++;
    }
  }

  async handleComment() {
    const comment = this.context.payload.comment;
    if (comment.body.trim() === "/apply-fix") {
      await this.handleApplyFix(comment);
    }
  }

  async analyzeCode(content, filename) {
    const messages = this.buildPromptMessages(content, filename);
    const response = await this.invokeBedrock(messages);
    return this.parseAnalysis(response);
  }

  buildPromptMessages(content, filename) {
    // Determinar la extensión del archivo para usarla en el formateo de código
    const extension = filename.split(".").pop().toLowerCase();

    // System prompt ahora usa el mismo formato que el user prompt con type y text
    const systemPrompt = {
      role: "system",
      content: [
        {
          type: "text",
          text: `## Code Review Assistant
You are an expert code reviewer with deep knowledge of best practices, security patterns, and clean code principles.

## Your Role
Analyze code files and provide detailed, constructive feedback on:
1. Security vulnerabilities
2. Performance issues
3. Code style/quality concerns
4. Logic errors
5. Best practice violations

## Output Format
Return your analysis as a JSON array of issues:
[
  {
    "severity": "ALTA",
    "line": 42,
    "description": "Concise issue description",
    "solution": "Fixed code example",
    "explanation": "Why this fix improves the code"
  }
]

For each issue found, provide:
- SEVERITY: Rate as CRÍTICA (critical), ALTA (high), MEDIA (medium), or BAJA (low)
- LOCATION: Line number(s) where the issue appears
- DESCRIPTION: Clear explanation of the problem
- SOLUTION: Concrete code example showing how to fix it
- EXPLANATION: Brief explanation of why your solution is better
If no issues are found, return an empty array: []`,
        },
      ],
    };

    // User prompt ahora se enfoca en enviar los archivos y cambios
    const userPrompt = {
      role: "user",
      content: [
        {
          type: "text",
          text: `## Code Review Assistant
You are an expert code reviewer with deep knowledge of best practices, security patterns, and clean code principles.

## Your Role
Analyze code files and provide detailed, constructive feedback on:
1. Security vulnerabilities
2. Performance issues
3. Code style/quality concerns
4. Logic errors
5. Best practice violations

## Output Format
Return your analysis as a JSON array of issues:
[
  {
    "severity": "ALTA",
    "line": 42,
    "description": "Concise issue description",
    "solution": "Fixed code example",
    "explanation": "Why this fix improves the code"
  }
]

For each issue found, provide:
- SEVERITY: Rate as CRÍTICA (critical), ALTA (high), MEDIA (medium), or BAJA (low)
- LOCATION: Line number(s) where the issue appears
- DESCRIPTION: Clear explanation of the problem
- SOLUTION: Concrete code example showing how to fix it
- EXPLANATION: Brief explanation of why your solution is better
If no issues are found, return an empty array: []
          ## File to Review
Filename: ${filename}
File type: ${extension}

## Code Content
\`\`\`${extension}
${content}
\`\`\`

Please analyze this file and identify any issues according to the criteria in your instructions.`,
        },
      ],
    };

    return [userPrompt];
  }

  async invokeBedrock(messages) {
    let payload = {
      modelId: this.bedrockModelId,
      contentType: "application/json",
      accept: "application/json",
    };

    if (this.bedrockModelId.includes("anthropic")) {
      payload.body = JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 4096,
        messages: messages,
      });
    } else if (this.bedrockModelId.includes("amazon")) {
      payload.body = JSON.stringify({
        inferenceConfig: {
          max_tokens: 1000,
          temperature: 0.2, // Temperatura baja para respuestas más precisas
        },
        messages: messages,
      });
    } else {
      // Soporte genérico para otros modelos
      payload.body = JSON.stringify({
        messages: messages,
        max_tokens: 4096,
        temperature: 0.1,
      });
    }

    const command = new InvokeModelCommand(payload);
    const response = await this.bedrock.send(command);
    return JSON.parse(new TextDecoder().decode(response.body));
  }

  async createReviewComments(path, analysis) {
    const filteredIssues = analysis.filter(
      (issue) =>
        severityLevel(issue.severity) >=
        severityLevel(this.config.commentThreshold)
    );

    for (const issue of filteredIssues) {
      console.log("ISSUE:::::", issue);
      const commentBody = this.formatComment(issue);
      await this.createComment(path, commentBody, issue.line);
    }
  }

  formatComment(issue) {
    return `
🤖 **Análisis de Código por AI**

**Severidad**: ${issue.severity}
**Problema**: ${issue.description || issue.issue}
**Sugerencia**: ${issue.explanation || issue.suggestion}

\`\`\`diff
${issue.solution || issue.code}
\`\`\`

${
  issue.canAutoFix
    ? "¿Deseas que aplique este cambio? Responde con `/apply-fix` para aplicarlo."
    : ""
}

Referencias:
${
  (issue.refs || []).map((ref) => `- ${ref}`).join("\n") ||
  "- Buenas prácticas de desarrollo"
}
    `;
  }

  async getFileContent(path) {
    const { data } = await this.octokit.rest.repos.getContent({
      ...this.context.repo,
      path,
      ref: this.context.payload.pull_request.head.sha,
    });
    return Buffer.from(data.content, "base64").toString("utf-8");
  }

  parseAnalysis(response) {
    try {
      // Extraer el contenido de la respuesta según el formato del modelo
      let content = "";
      if (response.content && Array.isArray(response.content)) {
        content = response.content[0].text;
      } else if (response.messages && Array.isArray(response.messages)) {
        content = response.messages[0].content[0].text;
      } else if (typeof response === "string") {
        content = response;
      }

      if (!content) {
        console.warn("No content found in response");
        return [];
      }

      // Intentar extraer array JSON de la respuesta
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const issues = JSON.parse(jsonMatch[0]);
          // Validar que cada issue tenga los campos requeridos
          return issues.filter(
            (issue) =>
              issue.severity &&
              issue.line &&
              (issue.description || issue.issue) &&
              (issue.solution || issue.code)
          );
        } catch (e) {
          console.warn(
            "Failed to parse JSON array, falling back to regex parsing"
          );
        }
      }

      // Si no se pudo extraer JSON válido, usar el método de respaldo con regex
      return this.fallbackParseWithRegex(content);
    } catch (error) {
      console.error("Error in parseAnalysis:", error);
      return [];
    }
  }

  fallbackParseWithRegex(content) {
    // Método de respaldo usando regex
    const issues = [];
    const regex = {
      line: /\"line\":\s*(\d+)/g,
      severity: /\"severity\":\s*\"(CRÍTICA|ALTA|MEDIA|BAJA)\"/g,
      description: /\"description\":\s*\"([^\"]+)\"/g,
      solution: /\"solution\":\s*\"([^\"]+)\"/g,
      explanation: /\"explanation\":\s*\"([^\"]+)\"/g,
    };

    // Encontrar todos los bloques que parecen JSON
    const jsonBlocks = content.match(/\{[^}]+\}/g) || [];

    for (const block of jsonBlocks) {
      try {
        const issue = {
          line: null,
          severity: "BAJA",
          description: "",
          solution: "",
          explanation: "",
        };

        // Extraer cada campo usando regex
        for (const [field, pattern] of Object.entries(regex)) {
          pattern.lastIndex = 0; // Resetear el índice
          const match = pattern.exec(block);
          if (match) {
            if (field === "line") {
              issue.line = parseInt(match[1]);
            } else {
              issue[field] = match[1]
                .replace(/\\n/g, "\n")
                .replace(/\\"/g, '"');
            }
          }
        }

        // Solo agregar el issue si tiene los campos mínimos necesarios
        if (issue.line && (issue.description || issue.solution)) {
          issues.push(issue);
        }
      } catch (e) {
        console.warn("Error processing JSON block:", e);
        continue;
      }
    }

    return issues;
  }

  async createComment(path, body, line) {
    try {
      console.log("Creating comment for:", { path, line });

      // Obtener el commit actual del PR
      const { data: pullRequest } = await this.octokit.rest.pulls.get({
        ...this.context.repo,
        pull_number: this.context.payload.pull_request.number,
      });

      const commitId = pullRequest.head.sha;

      // Crear el comentario directamente sin verificar el diff
      await this.octokit.rest.pulls.createReviewComment({
        ...this.context.repo,
        pull_number: this.context.payload.pull_request.number,
        commit_id: commitId,
        path,
        body,
        line,
        side: "RIGHT",
      });

      console.log("Comment created successfully");
    } catch (error) {
      console.error("Error creating comment:", error);
      throw error;
    }
  }

  async handleApplyFix(comment) {
    const pullRequestNumber = this.context.payload.issue.number;
    const reviewComments = await this.getReviewComments(pullRequestNumber);
    const fixComment = reviewComments.find(
      (rc) => rc.id === comment.in_reply_to_id
    );

    if (fixComment) {
      const { path, line, body } = fixComment;
      const fixCode = this.extractFixCode(body);
      if (fixCode) {
        await this.applyChanges(path, line, fixCode);
      }
    }
  }

  async getReviewComments(pullRequestNumber) {
    const { data: comments } = await this.octokit.rest.pulls.listReviewComments(
      {
        ...this.context.repo,
        pull_number: pullRequestNumber,
      }
    );
    return comments;
  }

  extractFixCode(commentBody) {
    const codeBlockRegex = /```diff\n([\s\S]*?)\n```/;
    const match = commentBody.match(codeBlockRegex);
    return match ? match[1] : null;
  }

  async applyChanges(path, line, fixCode) {
    const content = await this.getFileContent(path);
    const lines = content.split("\n");
    lines[line - 1] = fixCode.replace(/^[+-]\s/, "");
    const updatedContent = lines.join("\n");

    await this.octokit.rest.repos.createOrUpdateFileContents({
      ...this.context.repo,
      path,
      message: `Apply fix suggested by CodeReviewBot`,
      content: Buffer.from(updatedContent).toString("base64"),
      sha: this.context.payload.pull_request.head.sha,
      branch: this.context.payload.pull_request.head.ref,
    });
  }
}
module.exports = { CodeReviewBot };
