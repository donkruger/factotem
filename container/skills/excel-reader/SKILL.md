---
name: excel-reader
description: Read and extract data from Excel spreadsheets and CSV files. Use whenever you receive a spreadsheet attachment or need to read tabular data from files or URLs.
allowed-tools: Bash(excel-reader:*)
---

# Excel Reader

## Quick start

```bash
excel-reader extract report.xlsx              # Extract all sheets as CSV
excel-reader extract report.xlsx --sheet Sales # Extract specific sheet
excel-reader sheets report.xlsx               # List sheet names
excel-reader info report.xlsx                 # Show metadata (sheets, rows, cols, size)
excel-reader fetch https://example.com/data.xlsx  # Download and extract
excel-reader list                             # List all spreadsheets in directory tree
```

## Commands

### extract -- Extract spreadsheet data as CSV

```bash
excel-reader extract <file>                    # All sheets to stdout
excel-reader extract <file> --sheet <name>     # Specific sheet only
excel-reader extract <file> --sheet <name> --rows 1-50  # Row range
```

Options:
- `--sheet <name>` -- Extract only the named sheet. Without this, all sheets are printed with headers.
- `--rows N-M` -- Extract only rows N through M (1-based, inclusive). Header row is always included.

### sheets -- List all sheet names

```bash
excel-reader sheets <file>
```

Prints one sheet name per line with row/column counts.

### info -- File metadata

```bash
excel-reader info <file>
```

Shows sheet count, row/column counts per sheet, and file size on disk.

### fetch -- Download and extract from URL

```bash
excel-reader fetch <url>                       # Download, extract all sheets
excel-reader fetch <url> data.xlsx             # Also save a local copy
```

Downloads the file, detects format, and extracts all sheets.

### list -- Find all spreadsheets in directory tree

```bash
excel-reader list
```

Recursively lists all `.xlsx`, `.xls`, and `.csv` files with sheet counts and file sizes.

## WhatsApp spreadsheet attachments

When a user sends an Excel or CSV file on WhatsApp, it is automatically saved to the `attachments/` directory. You will see a message like:

```
[Document: attachments/Translation Matrix.xlsx (35KB)]
Use: excel-reader extract attachments/Translation Matrix.xlsx
```

Always extract and read the content rather than asking the user to describe the file.

## Example workflows

**Summarize a spreadsheet:**
```bash
excel-reader sheets attachments/report.xlsx
excel-reader extract attachments/report.xlsx --sheet Sheet1
```

**Compare two files:**
```bash
excel-reader extract old.xlsx --sheet Data > /tmp/old.csv
excel-reader extract new.xlsx --sheet Data > /tmp/new.csv
diff /tmp/old.csv /tmp/new.csv
```

**Extract from URL:**
```bash
excel-reader fetch https://example.com/quarterly-data.xlsx
```
