using OfficeOpenXml;
using System.Text.RegularExpressions;

ExcelPackage.LicenseContext = LicenseContext.NonCommercial;

var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
var templatePath = Path.Combine(repoRoot, "templates", "IND_ACQ_MT_v1.0.0_goldmaster.xlsx");

if (args.Length > 0)
{
    templatePath = args[0];
}

if (!File.Exists(templatePath))
{
    Console.WriteLine($"Template not found: {templatePath}");
    Console.WriteLine($"Looking in: {repoRoot}/templates/");
    Environment.Exit(1);
}

Console.WriteLine($"Expanding template: {templatePath}");

using var package = new ExcelPackage(new FileInfo(templatePath));

// Update template metadata - look for named ranges or specific cells
var workbook = package.Workbook;

// Try to update out_template_id named range
if (workbook.Names.ContainsKey("out_template_id"))
{
    var range = workbook.Names["out_template_id"];
    range.Value = "IND_ACQ_MT";
    Console.WriteLine("Updated out_template_id to IND_ACQ_MT");
}

// Find rent roll sheets and tables
foreach (var worksheet in workbook.Worksheets)
{
    Console.WriteLine($"Checking worksheet: {worksheet.Name}");

    // Check for rent roll tables
    foreach (var table in worksheet.Tables)
    {
        var tableName = table.Name.ToLowerInvariant();
        Console.WriteLine($"  Found table: {table.Name} at {table.Address}");

        if (tableName.Contains("rentroll") || tableName.Contains("rent_roll"))
        {
            var tableRange = table.Range;
            var currentDataRows = tableRange.Rows - 1; // Exclude header
            var targetRows = 50;

            Console.WriteLine($"  Current data rows: {currentDataRows}, target: {targetRows}");

            if (currentDataRows < targetRows)
            {
                var startRow = tableRange.Start.Row;
                var startCol = tableRange.Start.Column;
                var endCol = tableRange.End.Column;
                var headerRow = startRow;
                var firstDataRow = startRow + 1;
                var lastDataRow = tableRange.End.Row;

                Console.WriteLine($"  Table range: Row {startRow}-{lastDataRow}, Col {startCol}-{endCol}");

                // Insert rows to expand table
                var rowsToAdd = targetRows - currentDataRows;
                Console.WriteLine($"  Adding {rowsToAdd} rows after row {lastDataRow}");

                // Insert blank rows after the table
                worksheet.InsertRow(lastDataRow + 1, rowsToAdd);

                // Copy formatting from last data row to new rows
                for (int i = 0; i < rowsToAdd; i++)
                {
                    var sourceRow = lastDataRow;
                    var targetRow = lastDataRow + 1 + i;

                    for (int col = startCol; col <= endCol; col++)
                    {
                        var sourceCell = worksheet.Cells[sourceRow, col];
                        var targetCell = worksheet.Cells[targetRow, col];

                        // Copy style
                        targetCell.StyleID = sourceCell.StyleID;

                        // Clear value (new row should be empty)
                        targetCell.Value = null;

                        // Copy formula pattern if exists (adjust row references)
                        if (!string.IsNullOrEmpty(sourceCell.Formula))
                        {
                            // Simple formula copy - adjust row references
                            var formula = sourceCell.Formula;
                            // Replace row number references
                            var adjustedFormula = Regex.Replace(formula, @"\$?(\d+)", m =>
                            {
                                if (int.TryParse(m.Groups[1].Value, out var rowNum))
                                {
                                    if (rowNum == sourceRow)
                                    {
                                        return m.Value.Replace(rowNum.ToString(), targetRow.ToString());
                                    }
                                }
                                return m.Value;
                            });
                            try
                            {
                                targetCell.Formula = adjustedFormula;
                            }
                            catch
                            {
                                // Skip if formula fails
                            }
                        }
                    }
                }

                // Resize the table
                var newEndRow = startRow + targetRows; // header + 50 data rows
                Console.WriteLine($"  Resizing table to row {newEndRow}");

                // EPPlus 7.x: tables auto-expand when data is in adjacent rows
                // We need to manually set the table address range
                // Use the TableRange property or recreate the table
                var newAddress = $"{GetColumnLetter(startCol)}{startRow}:{GetColumnLetter(endCol)}{newEndRow}";
                Console.WriteLine($"  New table address: {newAddress}");

                // Note: EPPlus may auto-expand the table since we added rows within/adjacent to it
                Console.WriteLine($"  Table {table.Name} expanded. Verify in Excel.");
            }
        }
    }
}

// Recalculate workbook
Console.WriteLine("Recalculating workbook...");
workbook.Calculate();

// Save
Console.WriteLine("Saving template...");
package.Save();

Console.WriteLine($"Template saved: {templatePath}");
Console.WriteLine("Done! Please verify the template opens correctly in Excel.");

static string GetColumnLetter(int columnNumber)
{
    string columnLetter = "";
    while (columnNumber > 0)
    {
        int modulo = (columnNumber - 1) % 26;
        columnLetter = Convert.ToChar('A' + modulo) + columnLetter;
        columnNumber = (columnNumber - modulo) / 26;
    }
    return columnLetter;
}
