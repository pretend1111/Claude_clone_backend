#!/usr/bin/env python3.11
"""Generate PDF files from JSON input via stdin.

Input JSON format:
{
  "outputPath": "/path/to/output.pdf",
  "title": "Document Title",
  "author": "Author Name",
  "sections": [
    {"type": "heading", "content": "Section Title", "level": 1},
    {"type": "paragraph", "content": "Body text..."},
    {"type": "table", "headers": ["A","B"], "rows": [["1","2"]]},
    {"type": "list", "content": ["item1", "item2"], "ordered": false},
    {"type": "pagebreak"}
  ]
}
"""
import json
import sys
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm, cm
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, ListFlowable, ListItem, KeepTogether
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


def register_chinese_font():
    """Register a Chinese-capable font. Try common system paths."""
    candidates = [
        # Linux (Alibaba Cloud)
        "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/noto/NotoSansSC-Regular.otf",
        "/usr/share/fonts/google-noto/NotoSansSC-Regular.otf",
        "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf",
        "/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc",
        "/usr/share/fonts/wqy-microhei/wqy-microhei.ttc",
        # macOS
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
    ]
    for fp in candidates:
        if os.path.exists(fp):
            try:
                pdfmetrics.registerFont(TTFont("ChineseFont", fp))
                return "ChineseFont"
            except Exception:
                continue
    # Fallback: use Helvetica (Chinese chars will fail, but at least pure-ASCII works)
    return "Helvetica"


CJK_FONT = register_chinese_font()


PRIMARY = HexColor("#2D2D2D")
ACCENT = HexColor("#4472C4")
LIGHT_BG = HexColor("#F5F7FA")
BORDER_COLOR = HexColor("#D9D9D9")
WHITE = HexColor("#FFFFFF")


def make_styles():
    """Create custom paragraph styles."""
    base = getSampleStyleSheet()
    styles = {}
    styles["title"] = ParagraphStyle(
        "CustomTitle", parent=base["Title"],
        fontName=CJK_FONT,
        fontSize=26, leading=32, textColor=PRIMARY,
        alignment=TA_CENTER, spaceAfter=6 * mm,
    )
    styles["subtitle"] = ParagraphStyle(
        "CustomSubtitle", parent=base["Normal"],
        fontName=CJK_FONT,
        fontSize=14, leading=18, textColor=HexColor("#666666"),
        alignment=TA_CENTER, spaceAfter=20 * mm,
    )
    styles["h1"] = ParagraphStyle(
        "H1", parent=base["Heading1"],
        fontName=CJK_FONT,
        fontSize=20, leading=26, textColor=ACCENT,
        spaceBefore=8 * mm, spaceAfter=4 * mm,
    )
    styles["h2"] = ParagraphStyle(
        "H2", parent=base["Heading2"],
        fontName=CJK_FONT,
        fontSize=16, leading=22, textColor=PRIMARY,
        spaceBefore=6 * mm, spaceAfter=3 * mm,
    )
    styles["h3"] = ParagraphStyle(
        "H3", parent=base["Heading3"],
        fontName=CJK_FONT,
        fontSize=13, leading=18, textColor=HexColor("#444444"),
        spaceBefore=4 * mm, spaceAfter=2 * mm,
    )
    styles["body"] = ParagraphStyle(
        "Body", parent=base["Normal"],
        fontName=CJK_FONT,
        fontSize=11, leading=16, textColor=PRIMARY,
        alignment=TA_JUSTIFY, spaceAfter=3 * mm,
    )
    styles["table_header"] = ParagraphStyle(
        "TableHeader", parent=base["Normal"],
        fontName=CJK_FONT,
        fontSize=10, leading=14, textColor=WHITE,
    )
    styles["table_cell"] = ParagraphStyle(
        "TableCell", parent=base["Normal"],
        fontName=CJK_FONT,
        fontSize=10, leading=14, textColor=PRIMARY,
    )
    return styles


def header_footer(canvas, doc, title, author):
    """Draw header and footer on each page."""
    canvas.saveState()
    w, h = A4
    # Header line
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(0.5)
    canvas.line(2 * cm, h - 1.5 * cm, w - 2 * cm, h - 1.5 * cm)
    # Header text
    canvas.setFont(CJK_FONT, 8)
    canvas.setFillColor(HexColor("#999999"))
    canvas.drawString(2 * cm, h - 1.3 * cm, title)
    # Footer
    canvas.line(2 * cm, 1.5 * cm, w - 2 * cm, 1.5 * cm)
    canvas.drawString(2 * cm, 0.8 * cm, author or "")
    canvas.drawRightString(w - 2 * cm, 0.8 * cm, f"Page {doc.page}")
    canvas.restoreState()


def build_table(section, styles):
    """Build a reportlab Table from section data."""
    headers = section.get("headers", [])
    rows = section.get("rows", [])

    table_data = []
    if headers:
        table_data.append([Paragraph(str(h), styles["table_header"]) for h in headers])
    for row in rows:
        table_data.append([Paragraph(str(c), styles["table_cell"]) for c in row])

    if not table_data:
        return None

    num_cols = max(len(r) for r in table_data)
    avail_width = A4[0] - 4 * cm
    col_width = avail_width / num_cols

    t = Table(table_data, colWidths=[col_width] * num_cols)
    style_cmds = [
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER_COLOR),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]
    if headers:
        style_cmds.extend([
            ("BACKGROUND", (0, 0), (-1, 0), ACCENT),
            ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ])
        # Alternate row colors
        for i in range(1, len(table_data)):
            if i % 2 == 0:
                style_cmds.append(("BACKGROUND", (0, i), (-1, i), LIGHT_BG))

    t.setStyle(TableStyle(style_cmds))
    return t


def build_list(section, styles):
    """Build a ListFlowable from section data."""
    items_data = section.get("content", [])
    ordered = section.get("ordered", False)
    if isinstance(items_data, str):
        items_data = [line.strip() for line in items_data.split("\n") if line.strip()]

    items = []
    for item_text in items_data:
        items.append(ListItem(Paragraph(str(item_text), styles["body"]), leftIndent=10))

    bullet_type = "1" if ordered else "bullet"
    return ListFlowable(items, bulletType=bullet_type, start=1 if ordered else None)


def main():
    data = json.load(sys.stdin)
    output_path = data["outputPath"]
    title = data.get("title", "Document")
    author = data.get("author", "")
    sections = data.get("sections", [])

    styles = make_styles()

    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        topMargin=2 * cm, bottomMargin=2 * cm,
        leftMargin=2 * cm, rightMargin=2 * cm,
    )

    story = []

    # Cover: title + author + spacer
    story.append(Spacer(1, 40 * mm))
    story.append(Paragraph(title, styles["title"]))
    if author:
        story.append(Paragraph(author, styles["subtitle"]))
    story.append(Spacer(1, 10 * mm))
    # Decorative line
    line_table = Table([[""]], colWidths=[60 * mm], rowHeights=[1])
    line_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), ACCENT)]))
    story.append(line_table)
    story.append(Spacer(1, 20 * mm))

    heading_map = {1: "h1", 2: "h2", 3: "h3"}

    for sec in sections:
        sec_type = sec.get("type", "paragraph")

        if sec_type == "heading":
            level = sec.get("level", 1)
            style_key = heading_map.get(level, "h3")
            story.append(Paragraph(sec.get("content", ""), styles[style_key]))

        elif sec_type == "paragraph":
            text = sec.get("content", "")
            for para in text.split("\n\n"):
                para = para.strip()
                if para:
                    story.append(Paragraph(para, styles["body"]))

        elif sec_type == "table":
            t = build_table(sec, styles)
            if t:
                story.append(Spacer(1, 3 * mm))
                story.append(t)
                story.append(Spacer(1, 3 * mm))

        elif sec_type == "list":
            lst = build_list(sec, styles)
            story.append(lst)
            story.append(Spacer(1, 2 * mm))

        elif sec_type == "pagebreak":
            story.append(PageBreak())

    def on_page(canvas, doc_obj):
        header_footer(canvas, doc_obj, title, author)

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(json.dumps({"success": True, "path": output_path}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
