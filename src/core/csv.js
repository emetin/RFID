function parseRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field.trim());
      field = "";
    } else if (character === "\n") {
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parseProductCsv(text) {
  const rows = parseRows(String(text).replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("CSV must include a header and at least one product");
  const headers = rows[0].map((header) => header.toLowerCase());
  const required = ["sku", "name", "units_per_box", "boxes_per_pallet"];
  for (const header of required) {
    if (!headers.includes(header)) throw new Error(`Missing CSV column: ${header}`);
  }

  return rows.slice(1).map((values, rowIndex) => {
    const value = (name) => values[headers.indexOf(name)] ?? "";
    const unitsPerBox = Number(value("units_per_box"));
    const boxesPerPallet = Number(value("boxes_per_pallet"));
    if (!Number.isInteger(unitsPerBox) || unitsPerBox < 1) {
      throw new Error(`Row ${rowIndex + 2}: units_per_box must be a positive integer`);
    }
    if (!Number.isInteger(boxesPerPallet) || boxesPerPallet < 1) {
      throw new Error(`Row ${rowIndex + 2}: boxes_per_pallet must be a positive integer`);
    }
    return {
      sku: value("sku"),
      name: value("name"),
      category: value("category"),
      unitsPerBox,
      boxesPerPallet,
      size: value("size"),
      color: value("color")
    };
  });
}

export function parseAssetCsv(text) {
  const rows = parseRows(String(text).replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("CSV must include a header and at least one EPC");
  const headers = rows[0].map((header) => header.toLowerCase());
  for (const header of ["epc", "sku"]) {
    if (!headers.includes(header)) throw new Error(`Missing CSV column: ${header}`);
  }
  return rows.slice(1).map((values) => {
    const value = (name) => values[headers.indexOf(name)] ?? "";
    return {
      epc: value("epc").replace(/\s/g, "").toUpperCase(),
      sku: value("sku"),
      tid: value("tid") || null
    };
  });
}
