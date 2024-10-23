class DiffParser {
  parse(diffContent) {
    const changes = [];
    let currentChange = null;

    // Eliminar posibles marcadores de código
    const cleanDiff = diffContent.replace(/```diff\n|```/g, "").trim();
    const diffLines = cleanDiff.split("\n");

    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];

      // Detectar encabezados de fragmento (hunks)
      const hunkHeader = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
      );

      if (hunkHeader) {
        if (currentChange) {
          changes.push(this.finalizeChange(currentChange));
        }

        currentChange = {
          startLine: parseInt(hunkHeader[1]),
          oldLines: [],
          newLines: [],
          type: "replace",
        };
        continue;
      }

      if (!currentChange) {
        currentChange = {
          startLine: line,
          oldLines: [],
          newLines: [],
          type: "replace",
        };
      }

      // Procesar líneas de cambio
      if (line.startsWith("-")) {
        currentChange.oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        currentChange.newLines.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        currentChange.oldLines.push(line.slice(1));
        currentChange.newLines.push(line.slice(1));
      }
    }

    if (currentChange) {
      changes.push(this.finalizeChange(currentChange));
    }

    return changes;
  }

  finalizeChange(change) {
    if (change.oldLines.length === 0) {
      change.type = "insert";
    } else if (change.newLines.length === 0) {
      change.type = "delete";
    }
    return change;
  }
}

module.exports = { DiffParser };
