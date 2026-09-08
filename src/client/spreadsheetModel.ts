import type { SpreadsheetCell, SpreadsheetSheet, SpreadsheetValue, WorkbookData } from "../shared/types";

export const DEFAULT_SPREADSHEET_ROWS = 100;
export const DEFAULT_SPREADSHEET_COLUMNS = 26;

export function createBlankWorkbook(): WorkbookData {
  const id = crypto.randomUUID();
  return { activeSheetId: id, sheets: [{ id, name: "Sheet1", cells: {} }] };
}

export function columnName(index: number): string {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

export function columnIndex(name: string): number {
  return name.toUpperCase().split("").reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0) - 1;
}

export function cellAddress(row: number, column: number): string {
  return `${columnName(column)}${row + 1}`;
}

export function parseCellAddress(address: string): { row: number; column: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,5})$/i.exec(address.trim());
  if (!match) return null;
  return { row: Number(match[2]) - 1, column: columnIndex(match[1]) };
}

export function rawCellInput(cell: SpreadsheetCell | undefined): string {
  if (!cell) return "";
  if (cell.formula) return cell.formula.startsWith("=") ? cell.formula : `=${cell.formula}`;
  return cell.value === null ? "" : String(cell.value);
}

export function cellFromInput(input: string, current?: SpreadsheetCell): SpreadsheetCell | undefined {
  if (input === "") return current?.style && Object.keys(current.style).length ? { value: null, style: current.style } : undefined;
  const style = current?.style;
  if (input.startsWith("=")) return { value: null, formula: input, ...(style ? { style } : {}) };
  const trimmed = input.trim();
  let value: SpreadsheetValue = input;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) value = Number(trimmed);
  else if (/^true$/i.test(trimmed)) value = true;
  else if (/^false$/i.test(trimmed)) value = false;
  return { value, ...(style ? { style } : {}) };
}

export function evaluateCell(sheet: SpreadsheetSheet, address: string): SpreadsheetValue | string {
  return evaluateAddress(sheet, normalizeAddress(address), new Set());
}

function evaluateAddress(sheet: SpreadsheetSheet, address: string, visiting: Set<string>): SpreadsheetValue | string {
  const cell = sheet.cells[address];
  if (!cell) return null;
  if (!cell.formula) return cell.value;
  if (visiting.has(address)) return "#CYCLE!";
  visiting.add(address);
  try {
    const parser = new FormulaParser(cell.formula.replace(/^=/, ""), (reference) => evaluateAddress(sheet, reference, visiting));
    const value = parser.parse();
    if (isFormulaError(value) && cell.value !== null && ["#NAME?", "#ERROR!"].includes(value)) return cell.value;
    return Array.isArray(value) ? "#VALUE!" : value;
  } catch {
    return cell.value !== null ? cell.value : "#ERROR!";
  } finally {
    visiting.delete(address);
  }
}

export function formatCellValue(value: SpreadsheetValue | string, format = "General"): string {
  if (value === null) return "";
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  if (format.includes("%")) {
    const decimals = format.includes(".00") ? 2 : format.includes(".0") ? 1 : 0;
    return new Intl.NumberFormat(undefined, { style: "percent", minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  }
  const currency = format.includes("£") ? "GBP" : format.includes("€") ? "EUR" : format.includes("$") ? "USD" : null;
  if (currency) {
    const decimals = format.includes(".00") ? 2 : 0;
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  }
  const decimals = format.includes(".00") ? 2 : format.includes(".0") ? 1 : format === "0" ? 0 : undefined;
  return new Intl.NumberFormat(undefined, {
    useGrouping: format.includes(","),
    ...(decimals === undefined ? { maximumFractionDigits: 10 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
  }).format(value);
}

export function sheetExtent(sheet: SpreadsheetSheet): { rows: number; columns: number } {
  let rows = DEFAULT_SPREADSHEET_ROWS;
  let columns = DEFAULT_SPREADSHEET_COLUMNS;
  Object.keys(sheet.cells).forEach((address) => {
    const parsed = parseCellAddress(address);
    if (!parsed) return;
    rows = Math.max(rows, parsed.row + 2);
    columns = Math.max(columns, parsed.column + 2);
  });
  return { rows: Math.min(rows, 2_000), columns: Math.min(columns, 100) };
}

type FormulaScalar = SpreadsheetValue | string;
type FormulaValue = FormulaScalar | FormulaScalar[];
type TokenType = "number" | "string" | "reference" | "identifier" | "operator" | "eof";
interface Token { type: TokenType; value: string }

class FormulaParser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(source: string, private readonly resolve: (reference: string) => FormulaScalar) {
    this.tokens = tokenize(source);
  }

  parse(): FormulaValue {
    const value = this.comparison();
    if (this.peek().type !== "eof") return "#ERROR!";
    return value;
  }

  private comparison(): FormulaValue {
    let left = this.additive();
    while (["=", "<>", "<", ">", "<=", ">="].includes(this.peek().value)) {
      const operator = this.take().value;
      const right = this.additive();
      if (Array.isArray(left) || Array.isArray(right)) return "#VALUE!";
      const a = comparable(left); const b = comparable(right);
      left = operator === "=" ? a === b : operator === "<>" ? a !== b : operator === "<" ? a < b : operator === ">" ? a > b : operator === "<=" ? a <= b : a >= b;
    }
    return left;
  }

  private additive(): FormulaValue {
    let left = this.multiplicative();
    while (["+", "-", "&"].includes(this.peek().value)) {
      const operator = this.take().value;
      const right = this.multiplicative();
      if (Array.isArray(left) || Array.isArray(right)) return "#VALUE!";
      if (operator === "&") left = `${left ?? ""}${right ?? ""}`;
      else {
        const a = numeric(left); const b = numeric(right);
        left = Number.isNaN(a) || Number.isNaN(b) ? "#VALUE!" : operator === "+" ? a + b : a - b;
      }
    }
    return left;
  }

  private multiplicative(): FormulaValue {
    let left = this.power();
    while (["*", "/"].includes(this.peek().value)) {
      const operator = this.take().value;
      const right = this.power();
      if (Array.isArray(left) || Array.isArray(right)) return "#VALUE!";
      const a = numeric(left); const b = numeric(right);
      if (Number.isNaN(a) || Number.isNaN(b)) left = "#VALUE!";
      else if (operator === "/" && b === 0) left = "#DIV/0!";
      else left = operator === "*" ? a * b : a / b;
    }
    return left;
  }

  private power(): FormulaValue {
    let left = this.unary();
    while (this.peek().value === "^") {
      this.take();
      const right = this.unary();
      if (Array.isArray(left) || Array.isArray(right)) return "#VALUE!";
      const a = numeric(left); const b = numeric(right);
      left = Number.isNaN(a) || Number.isNaN(b) ? "#VALUE!" : a ** b;
    }
    return left;
  }

  private unary(): FormulaValue {
    if (["+", "-"].includes(this.peek().value)) {
      const operator = this.take().value;
      const value = this.unary();
      if (Array.isArray(value)) return "#VALUE!";
      const number = numeric(value);
      return Number.isNaN(number) ? "#VALUE!" : operator === "-" ? -number : number;
    }
    return this.primary();
  }

  private primary(): FormulaValue {
    const token = this.take();
    if (token.type === "number") return Number(token.value);
    if (token.type === "string") return token.value;
    if (token.type === "reference") {
      const start = normalizeAddress(token.value);
      if (this.peek().value === ":") {
        this.take();
        const end = this.take();
        if (end.type !== "reference") return "#REF!";
        return expandRange(start, normalizeAddress(end.value)).map(this.resolve);
      }
      return this.resolve(start);
    }
    if (token.type === "identifier") {
      const name = token.value.toUpperCase();
      if (name === "TRUE") return true;
      if (name === "FALSE") return false;
      if (this.peek().value !== "(") return "#NAME?";
      this.take();
      const args: FormulaValue[] = [];
      if (this.peek().value !== ")") {
        do { args.push(this.comparison()); } while (this.peek().value === "," && Boolean(this.take()));
      }
      if (this.take().value !== ")") return "#ERROR!";
      return callFunction(name, args);
    }
    if (token.value === "(") {
      const value = this.comparison();
      if (this.take().value !== ")") return "#ERROR!";
      return value;
    }
    return "#ERROR!";
  }

  private peek(): Token { return this.tokens[this.index] || { type: "eof", value: "" }; }
  private take(): Token { const token = this.peek(); this.index += 1; return token; }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) { index += whitespace[0].length; continue; }
    if (rest[0] === '"') {
      let value = ""; index += 1;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') { value += '"'; index += 2; continue; }
        if (source[index] === '"') { index += 1; break; }
        value += source[index]; index += 1;
      }
      tokens.push({ type: "string", value }); continue;
    }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
    if (number) { tokens.push({ type: "number", value: number[0] }); index += number[0].length; continue; }
    const reference = /^\$?[A-Z]{1,3}\$?[1-9][0-9]{0,5}/i.exec(rest);
    if (reference) { tokens.push({ type: "reference", value: reference[0] }); index += reference[0].length; continue; }
    const identifier = /^[A-Z_][A-Z0-9_.]*/i.exec(rest);
    if (identifier) { tokens.push({ type: "identifier", value: identifier[0] }); index += identifier[0].length; continue; }
    const operator = /^(?:<>|<=|>=|[()+\-*/^,:&=<>])/.exec(rest);
    if (operator) { tokens.push({ type: "operator", value: operator[0] }); index += operator[0].length; continue; }
    tokens.push({ type: "operator", value: "?" }); index += 1;
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

function callFunction(name: string, args: FormulaValue[]): FormulaValue {
  const flat = args.flatMap((value) => Array.isArray(value) ? value : [value]);
  const numbers = flat.map(numeric).filter((value) => !Number.isNaN(value));
  if (name === "SUM") return numbers.reduce((total, value) => total + value, 0);
  if (name === "AVERAGE") return numbers.length ? numbers.reduce((total, value) => total + value, 0) / numbers.length : "#DIV/0!";
  if (name === "MIN") return numbers.length ? Math.min(...numbers) : 0;
  if (name === "MAX") return numbers.length ? Math.max(...numbers) : 0;
  if (name === "COUNT") return numbers.length;
  if (name === "COUNTA") return flat.filter((value) => value !== null && value !== "").length;
  if (name === "IF") return truthy(scalar(args[0])) ? scalar(args[1]) : scalar(args[2]);
  if (name === "ROUND") {
    const value = numeric(scalar(args[0])); const digits = numeric(scalar(args[1]));
    if (Number.isNaN(value) || Number.isNaN(digits)) return "#VALUE!";
    const factor = 10 ** digits; return Math.round(value * factor) / factor;
  }
  if (name === "ABS") { const value = numeric(scalar(args[0])); return Number.isNaN(value) ? "#VALUE!" : Math.abs(value); }
  return "#NAME?";
}

function expandRange(start: string, end: string): string[] {
  const a = parseCellAddress(start); const b = parseCellAddress(end);
  if (!a || !b) return [];
  const addresses: string[] = [];
  for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row += 1) {
    for (let column = Math.min(a.column, b.column); column <= Math.max(a.column, b.column); column += 1) {
      addresses.push(cellAddress(row, column));
    }
  }
  return addresses;
}

function normalizeAddress(value: string): string { return value.replace(/\$/g, "").toUpperCase(); }
function scalar(value: FormulaValue | undefined): FormulaScalar { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function numeric(value: FormulaScalar): number { if (value === null || value === "") return 0; if (typeof value === "boolean") return value ? 1 : 0; if (typeof value === "number") return value; const number = Number(value); return Number.isFinite(number) ? number : Number.NaN; }
function comparable(value: FormulaScalar): string | number | boolean { const number = numeric(value); return Number.isNaN(number) ? String(value ?? "").toLowerCase() : number; }
function truthy(value: FormulaScalar): boolean { return typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : Boolean(value); }
function isFormulaError(value: FormulaValue): value is string { return typeof value === "string" && value.startsWith("#"); }
