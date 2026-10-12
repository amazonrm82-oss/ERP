"use client";

import { useMemo, useRef, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { encodeQr, qrSvg, type QrCode } from "@/lib/qr";

import { QrImage } from "./qr-image";

// pixels per module in the PNG: a 300 to 600 pixel image for a form link, sharp in print
const PNG_SCALE = 12;

/** The colours the code is drawn in on screen (design tokens), as plain CSS colours for a file. */
function drawnColours(svg: SVGSVGElement | null): { dark: string; light: string } {
  if (!svg) return { dark: "black", light: "white" };
  const style = getComputedStyle(svg);
  return { dark: style.color || "black", light: style.backgroundColor || "white" };
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pngOf(code: QrCode, colours: { dark: string; light: string }): Promise<Blob | null> {
  const dim = (code.size + 8) * PNG_SCALE;
  const canvas = document.createElement("canvas");
  canvas.width = dim;
  canvas.height = dim;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  context.fillStyle = colours.light;
  context.fillRect(0, 0, dim, dim);
  context.fillStyle = colours.dark;
  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) context.fillRect((x + 4) * PNG_SCALE, (y + 4) * PNG_SCALE, PNG_SCALE, PNG_SCALE);
    });
  });
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

type Props = {
  // what the code opens
  url: string;
  // the printable poster
  printUrl: string;
  // file name, without extension
  fileName: string;
};

/** The form's QR code (CAP-03): on screen, as a PNG or SVG file, and a page to print. */
export function FormQr({ url, printUrl, fileName }: Props) {
  const code = useMemo(() => encodeQr(url), [url]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex flex-wrap items-start gap-4">
      <span className="rounded-md border border-line">
        <QrImage ref={svgRef} code={code} label="קוד QR של הטופס" className="size-40 rounded-md" />
      </span>
      <div className="min-w-0 flex-1 basis-48 space-y-2">
        <p className="text-md text-ink-soft">סורקים עם המצלמה של הטלפון ומגיעים ישר לטופס. מתאים לשלט, לפלייר או לכרטיס ביקור.</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              const blob = await pngOf(code, drawnColours(svgRef.current));
              setFailed(!blob);
              if (blob) save(blob, `${fileName}.png`);
            }}
          >
            הורדה כתמונה (PNG)
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => save(new Blob([qrSvg(code, drawnColours(svgRef.current))], { type: "image/svg+xml" }), `${fileName}.svg`)}
          >
            הורדה לדפוס (SVG)
          </Button>
          <a href={printUrl} target="_blank" rel="noopener" className={buttonClasses("secondary", "sm")}>
            דף להדפסה
            <span className="sr-only"> (נפתח בחלון חדש)</span>
          </a>
        </div>
        {failed ? (
          <p role="alert" className="text-sm text-danger">
            הדפדפן לא הצליח ליצור את התמונה. נסו את ההורדה לדפוס (SVG).
          </p>
        ) : null}
      </div>
    </div>
  );
}
