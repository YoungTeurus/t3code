export const normalizeArcCheckpointNumstat = (output: string): string => {
  const fields = output.split("\0");
  const records: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (fields[i] === "" && i === fields.length - 1) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]!);
    if (!match) throw new TypeError("Malformed checkpoint diff statistics.");
    const prefix = `${match[1]}\t${match[2]}\t`;
    if (match[3]) records.push(`${prefix}${match[3].replace(/^[ab]\//, "")}\0`);
    else {
      const old = fields[++i];
      const next = fields[++i];
      if (old === undefined || next === undefined)
        throw new TypeError("Incomplete checkpoint diff statistics.");
      const oldPath = old.replace(/^a\//, "");
      const newPath = next.replace(/^b\//, "");
      if (oldPath === "/dev/null" || oldPath === newPath) records.push(`${prefix}${newPath}\0`);
      else if (newPath === "/dev/null") records.push(`${prefix}${oldPath}\0`);
      else records.push(`${prefix}\0${oldPath}\0${newPath}\0`);
    }
  }
  return records.join("");
};
