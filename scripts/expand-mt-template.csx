#!/usr/bin/env dotnet-script
// Expand IND_ACQ_MT template rent roll tables to 50 rows
// Usage: dotnet script expand-mt-template.csx

#r "nuget: EPPlus, 7.5.2"

using OfficeOpenXml;
using OfficeOpenXml.Table;
using System;
using System.IO;
using System.Linq;

ExcelPackage.LicenseContext = LicenseContext.NonCommercial;

var templatePath = Path.GetFullPath(Path.Combine(
    Path.GetDirectoryName(Args.Count > 0 ? Args[0] : Environment.CurrentDirectory) ?? ".",
    "..", "templates", "IND_ACQ_MT_v1.0.0_goldmaster.xlsx"
));

if (Args.Count > 0)
{
    templatePath = Args[0];
}

if (!File.Exists(templatePath))
{
    Console.WriteLine($"Template not found: {templatePath}");
    Environment.Exit(1);
}

Console.WriteLine($"Expanding template: {templatePath}");

using var package = new ExcelPackage(new FileInfo(templatePath));

// Update template metadata
var metaSheet = package.Workbook.Worksheets["_TEMPLATE_META"]
    ?? package.Workbook.Worksheets.FirstOrDefault(w => w.Name.Contains("META"));

if (metaSheet != null)
{
    // Find and update template_id
    for (int row = 1; row <= 20; row++)
    {
        var cellA = metaSheet.Cells[row, 1].Text;
        if (cellA.Equals("template_id", StringComparison.OrdinalIgnoreCase))
        {
            metaSheet.Cells[row, 2].Value = "IND_ACQ_MT";
            Console.WriteLine($"Updated template_id to IND_ACQ_MT");
        }
        else if (cellA.Equals("template_version", StringComparison.OrdinalIgnoreCase))
        {
            metaSheet.Cells[row, 2].Value = "1.0.0";
            Console.WriteLine($"Set template_version to 1.0.0");
        }
        else if (cellA.Equals("contract_version", StringComparison.OrdinalIgnoreCase))
        {
            metaSheet.Cells[row, 2].Value = "IND_ACQ_V1";
            Console.WriteLine($"Set contract_version to IND_ACQ_V1");
        }
    }
}
else
{
    Console.WriteLine("Warning: _TEMPLATE_META sheet not found");
}

// Find and expand rent roll tables
foreach (var worksheet in package.Workbook.Worksheets)
{
    foreach (var table in worksheet.Tables)
    {
        if (table.Name.Contains("rentroll", StringComparison.OrdinalIgnoreCase))
        {
            var currentRows = table.Range.Rows - 1; // Exclude header
            var targetRows = 50;

            if (currentRows < targetRows)
            {
                Console.WriteLine($"Expanding table {table.Name} from {currentRows} to {targetRows} rows");

                // Get table range info
                var startRow = table.Range.Start.Row;
                var startCol = table.Range.Start.Column;
                var endCol = table.Range.End.Column;
                var lastDataRow = table.Range.End.Row;

                // Copy the last data row format to new rows
                var rowsToAdd = targetRows - currentRows;
                for (int i = 0; i < rowsToAdd; i++)
                {
                    var newRow = lastDataRow + 1 + i;
                    for (int col = startCol; col <= endCol; col++)
                    {
                        // Clear any values (will be empty rows)
                        worksheet.Cells[newRow, col].Value = null;
                        // Copy formatting from last row
                        worksheet.Cells[lastDataRow, col].Copy(worksheet.Cells[newRow, col]);
                        worksheet.Cells[newRow, col].Value = null;
                    }
                }

                // Resize the table
                var newEndRow = startRow + targetRows; // header + 50 data rows
                var newAddress = new ExcelAddress(startRow, startCol, newEndRow, endCol);

                // EPPlus 7.x uses different API for table resize
                try
                {
                    // Get current table address and extend it
                    var tableAddress = table.Address;
                    var newTableAddress = $"{worksheet.Cells[startRow, startCol].Address}:{worksheet.Cells[newEndRow, endCol].Address}";

                    // Use reflection or direct property if available
                    var addressProperty = table.GetType().GetProperty("Address");
                    if (addressProperty != null && addressProperty.CanWrite)
                    {
                        addressProperty.SetValue(table, new ExcelAddressBase(newTableAddress));
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Note: Could not resize table programmatically: {ex.Message}");
                    Console.WriteLine("Table will need manual adjustment in Excel");
                }
            }
            else
            {
                Console.WriteLine($"Table {table.Name} already has {currentRows} rows (>= {targetRows})");
            }
        }
    }
}

// Recalculate
package.Workbook.Calculate();

// Save
package.Save();
Console.WriteLine($"Template saved: {templatePath}");
Console.WriteLine("Done!");
