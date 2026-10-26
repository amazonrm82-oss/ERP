// QUO-06: the part of pdfkit (0.20.2, which ships no types) that render.ts uses. Kept small on purpose instead of a second
// dependency (@types/pdfkit); render.ts is the only importer.
declare module "pdfkit" {
  type Options = {
    size?: string | [number, number];
    margin?: number;
    autoFirstPage?: boolean;
    bufferPages?: boolean;
    font?: string | Buffer;
    lang?: string;
    displayTitle?: boolean;
    info?: { Title?: string; Author?: string; Subject?: string; Creator?: string };
  };
  type TextOptions = {
    lineBreak?: boolean;
    // a string is handed to fontkit's layout as the script tag (see render.ts)
    features?: string;
  };
  type ImageOptions = { fit?: [number, number]; align?: "left" | "center" | "right"; valign?: "top" | "center" | "bottom" };

  class PDFDocument {
    constructor(options?: Options);
    registerFont(name: string, src: Buffer): this;
    font(name: string): this;
    fontSize(size: number): this;
    fillColor(color: string): this;
    strokeColor(color: string): this;
    lineWidth(width: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    text(text: string, x: number, y: number, options?: TextOptions): this;
    widthOfString(text: string, options?: TextOptions): number;
    image(src: Buffer, x: number, y: number, options?: ImageOptions): this;
    addPage(options?: { size?: string; margin?: number }): this;
    bufferedPageRange(): { start: number; count: number };
    switchToPage(index: number): this;
    on(event: "data", listener: (chunk: Uint8Array) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: unknown) => void): this;
    end(): void;
  }
  export default PDFDocument;
}
