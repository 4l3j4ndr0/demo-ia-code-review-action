const github = require("@actions/github");
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const { DiffParser } = require("./diff-parser");
const { shouldAnalyzeFile, severityLevel } = require("./utils");

class CodeReviewBot {
  constructor(config) {
    this.validateConfig(config);
    this.config = config;
    this.octokit = github.getOctokit(config.githubToken);
    this.bedrock = new BedrockRuntimeClient(config.awsConfig);
    this.context = github.context;
    this.diffParser = new DiffParser();
    this.bedrockModelId = config.bedrockModelId;
  }

  validateConfig(config) {
    const requiredFields = [
      "githubToken",
      "awsConfig",
      "bedrockModelId",
      "maxFiles",
      "commentThreshold",
    ];
    for (const field of requiredFields) {
      if (!config[field]) {
        throw new Error(`Missing required configuration field: ${field}`);
      }
    }
  }

  async run() {
    try {
      switch (this.context.eventName) {
        case "pull_request":
          await this.handlePullRequest();
          break;
        case "issue_comment":
          await this.handleComment();
          break;
        default:
          console.log(`Unsupported event type: ${this.context.eventName}`);
      }
    } catch (error) {
      console.error("Error in bot execution:", error);
      throw error;
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
    const errors = [];

    for (const file of files) {
      try {
        if (analyzedFiles >= this.config.maxFiles) break;
        if (!shouldAnalyzeFile(file.filename, this.config.excludePatterns))
          continue;

        const content = await this.getFileContent(file.filename);
        const analysis = await this.analyzeCode(content, file.filename);

        if (analysis.length > 0) {
          console.log(`Found ${analysis.length} issues in ${file.filename}`);
          await this.createReviewComments(file.filename, analysis);
        }

        analyzedFiles++;
      } catch (error) {
        errors.push({ file: file.filename, error });
        console.error(`Error analyzing ${file.filename}:`, error);
      }
    }

    if (errors.length > 0) {
      console.warn("Completed with some errors:", errors);
    }
  }

  async handleComment() {
    const comment = this.context.payload.comment;
    if (comment.body.trim() === "/apply-fix") {
      await this.handleApplyFix(comment);
    }
  }

  async analyzeCode(content, filename) {
    try {
      const prompt = this.buildPrompt(content, filename);
      const response = await this.invokeBedrock(prompt);
      const analysis = this.parseAnalysis(response);

      return analysis.filter((issue) => this.isValidIssue(issue));
    } catch (error) {
      console.error(`Error analyzing code for ${filename}:`, error);
      return [];
    }
  }

  buildPrompt(content, filename) {
    const extension = filename.split(".").pop();
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: `Analiza el siguiente código ${extension.toUpperCase()} y proporciona un análisis detallado.
              Enfócate en:
              1. Bugs potenciales o actuales
              2. Vulnerabilidades de seguridad
              3. Problemas de rendimiento
              4. Mejores prácticas específicas para ${extension}
              5. Sugerencias de refactorización

              Para cada problema identificado, proporciona la información en el siguiente formato JSON exacto:

              {
                "line": <número_de_línea>,
                "severity": "<CRÍTICA|ALTA|MEDIA|BAJA>",
                "issue": "<descripción breve del problema>",
                "suggestion": "<sugerencia de solución>",
                "code": "<código corregido>",
                "refs": ["<enlace1>", "<enlace2>", ...],
                "canAutoFix": <true|false>
              }

              Archivo: ${filename}
              Contenido:
              ${content}`,
        },
      ],
    };
  }

  async invokeBedrock(prompt) {
    let payload = {
      modelId: this.bedrockModelId,
      contentType: "application/json",
      accept: "application/json",
    };

    try {
      if (this.bedrockModelId.includes("anthropic")) {
        payload.body = JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 4096,
          messages: [prompt],
        });
      } else if (this.bedrockModelId.includes("amazon")) {
        payload.body = JSON.stringify({
          inferenceConfig: {
            max_tokens: 1000,
          },
          messages: [prompt],
        });
      }

      const command = new InvokeModelCommand(payload);
      const response = await this.bedrock.send(command);
      return JSON.parse(new TextDecoder().decode(response.body));
    } catch (error) {
      console.error("Error invoking Bedrock:", error);
      throw error;
    }
  }

  async createReviewComments(path, analysis) {
    const validIssues = analysis.filter(
      (issue) =>
        this.isValidIssue(issue) &&
        severityLevel(issue.severity) >=
          severityLevel(this.config.commentThreshold)
    );

    for (const issue of validIssues) {
      try {
        const commentBody = this.formatComment(issue);
        await this.createComment(path, commentBody, issue.line);
      } catch (error) {
        console.error(
          `Error creating comment for ${path} at line ${issue.line}:`,
          error
        );
      }
    }
  }

  formatComment(issue) {
    return `
🤖 **Análisis de Código por AI**

**Severidad**: ${issue.severity}
**Problema**: ${issue.issue}
**Sugerencia**: ${issue.suggestion}

\`\`\`diff
${issue.code}
\`\`\`

${
  issue.canAutoFix
    ? "¿Deseas que aplique este cambio? Responde con `/apply-fix` para aplicarlo."
    : ""
}

Referencias:
${issue.refs.map((ref) => `- ${ref}`).join("\n")}
    `;
  }

  async getFileContent(path) {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        ...this.context.repo,
        path,
        ref: this.context.payload.pull_request.head.sha,
      });
      return Buffer.from(data.content, "base64").toString("utf-8");
    } catch (error) {
      console.error(`Error getting file content for ${path}:`, error);
      throw error;
    }
  }

  parseAnalysis(response) {
    try {
      let content = this.extractContent(response);
      if (!content) return [];

      const jsonObjects = content.match(/\{[\s\S]*?\}/g) || [];
      return jsonObjects
        .map(this.parseJsonObject)
        .filter((item) => item !== null);
    } catch (error) {
      console.error("Error parsing analysis:", error);
      return [];
    }
  }

  extractContent(response) {
    if (response.content?.[0]?.text) {
      return response.content[0].text;
    }
    if (response.messages?.[0]?.content?.[0]?.text) {
      return response.messages[0].content[0].text;
    }
    if (typeof response === "string") {
      return response;
    }
    return null;
  }

  parseJsonObject(jsonString) {
    try {
      jsonString = jsonString.replace(
        /("code":\s*")([^"]*)(")/,
        (_, p1, p2, p3) => p1 + p2.replace(/\n/g, "\\n") + p3
      );

      if (!jsonString.endsWith("}")) {
        jsonString += "}";
      }

      const parsed = JSON.parse(jsonString);

      if (!parsed.line || typeof parsed.line !== "number") {
        return null;
      }

      return parsed;
    } catch (error) {
      console.warn("Error parsing JSON object:", error);
      return null;
    }
  }

  isValidIssue(issue) {
    return (
      issue &&
      typeof issue.line === "number" &&
      issue.line > 0 &&
      issue.severity &&
      issue.issue &&
      issue.suggestion
    );
  }

  async createComment(path, body, line) {
    try {
      if (!line || typeof line !== "number") {
        throw new Error(`Invalid line number for file ${path}: ${line}`);
      }

      const { data: pullRequest } = await this.octokit.rest.pulls.get({
        ...this.context.repo,
        pull_number: this.context.payload.pull_request.number,
      });

      await this.octokit.rest.pulls.createReviewComment({
        ...this.context.repo,
        pull_number: this.context.payload.pull_request.number,
        commit_id: pullRequest.head.sha,
        path,
        body,
        position: line,
        side: "RIGHT",
      });

      console.log(`Successfully created comment for ${path} at line ${line}`);
    } catch (error) {
      console.error(`Error creating comment for ${path}:`, error);
      throw error;
    }
  }

  async handleApplyFix(comment) {
    try {
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
          console.log(`Successfully applied fix to ${path} at line ${line}`);
        }
      }
    } catch (error) {
      console.error("Error handling apply fix:", error);
      throw error;
    }
  }

  async getReviewComments(pullRequestNumber) {
    try {
      const { data: comments } =
        await this.octokit.rest.pulls.listReviewComments({
          ...this.context.repo,
          pull_number: pullRequestNumber,
        });
      return comments;
    } catch (error) {
      console.error("Error getting review comments:", error);
      throw error;
    }
  }

  extractFixCode(commentBody) {
    const codeBlockRegex = /```diff\n([\s\S]*?)\n```/;
    const match = commentBody.match(codeBlockRegex);
    return match ? match[1] : null;
  }

  async applyChanges(path, line, fixCode) {
    try {
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
    } catch (error) {
      console.error(`Error applying changes to ${path}:`, error);
      throw error;
    }
  }
}

module.exports = { CodeReviewBot };
