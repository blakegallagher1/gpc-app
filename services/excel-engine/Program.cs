using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Linq;
using OfficeOpenXml;
using OfficeOpenXml.Table;

var builder = WebApplication.CreateBuilder(args);

// Helper to mask secrets for logging (show first 4 and last 4 chars only)
static string MaskSecret(string? secret)
{
    if (string.IsNullOrEmpty(secret)) return "[not set]";
    if (secret.Length <= 8) return "****";
    return $"{secret[..4]}...{secret[^4..]}";
}

// Helper to mask Authorization tokens in URLs
static string MaskUrlToken(string? url)
{
    if (string.IsNullOrEmpty(url)) return "[not set]";
    // Mask Authorization parameter in query string
    var authIndex = url.IndexOf("Authorization=", StringComparison.OrdinalIgnoreCase);
    if (authIndex > 0)
    {
        var endIndex = url.IndexOf('&', authIndex);
        var tokenStart = authIndex + 14; // Length of "Authorization="
        if (endIndex < 0) endIndex = url.Length;
        var tokenLength = endIndex - tokenStart;
        if (tokenLength > 8)
        {
            return url[..tokenStart] + url[tokenStart..(tokenStart + 4)] + "..." + url[(endIndex - 4)..];
        }
        return url[..tokenStart] + "****" + url[endIndex..];
    }
    return url;
}

// Structured log helper
static void LogStructured(string level, string message, object? data = null)
{
    var logEntry = new
    {
        timestamp = DateTime.UtcNow.ToString("O"),
        level,
        message,
        data
    };
    Console.WriteLine(JsonSerializer.Serialize(logEntry));
}

// Backblaze B2 native API configuration (trim values to prevent whitespace issues)
var b2KeyId = Environment.GetEnvironmentVariable("B2_KEY_ID")?.Trim();
var b2AppKey = Environment.GetEnvironmentVariable("B2_APPLICATION_KEY")?.Trim();
var b2Bucket = Environment.GetEnvironmentVariable("B2_BUCKET")?.Trim();
var b2BucketId = Environment.GetEnvironmentVariable("B2_BUCKET_ID")?.Trim();
var b2DownloadUrlOverride = Environment.GetEnvironmentVariable("B2_DOWNLOAD_URL")?.Trim();
var b2AuthCacheTtl = int.TryParse(Environment.GetEnvironmentVariable("B2_AUTH_CACHE_TTL_SECONDS")?.Trim(), out var cacheTtl) ? cacheTtl : 3600;
var b2DownloadAuthTtl = int.TryParse(Environment.GetEnvironmentVariable("B2_DOWNLOAD_AUTH_TTL_SECONDS")?.Trim(), out var downloadAuthTtl) ? downloadAuthTtl : 3600;

B2Client? b2Client = null;
if (!string.IsNullOrEmpty(b2KeyId) && !string.IsNullOrEmpty(b2AppKey) && !string.IsNullOrEmpty(b2BucketId))
{
    b2Client = new B2Client(b2KeyId, b2AppKey, b2BucketId, b2Bucket, b2DownloadUrlOverride, b2AuthCacheTtl, b2DownloadAuthTtl);
    LogStructured("INFO", "B2 client initialized", new
    {
        bucket = b2Bucket,
        bucketId = b2BucketId,
        keyId = MaskSecret(b2KeyId),
        authCacheTtl = b2AuthCacheTtl,
        downloadAuthTtl = b2DownloadAuthTtl
    });
}
else if (!string.IsNullOrEmpty(b2Bucket) || !string.IsNullOrEmpty(b2KeyId))
{
    LogStructured("WARN", "B2 partially configured - file uploads disabled", new
    {
        hasKeyId = !string.IsNullOrEmpty(b2KeyId),
        hasAppKey = !string.IsNullOrEmpty(b2AppKey),
        hasBucket = !string.IsNullOrEmpty(b2Bucket),
        hasBucketId = !string.IsNullOrEmpty(b2BucketId)
    });
}

var port = Environment.GetEnvironmentVariable("PORT") ?? "5001";
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

// Ops hardening settings
var debugEnabled = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("DEBUG"));
var maxConcurrentJobs = int.TryParse(Environment.GetEnvironmentVariable("MAX_CONCURRENT_JOBS")?.Trim(), out var mcj) ? mcj : 10;
var jobSemaphore = new SemaphoreSlim(maxConcurrentJobs, maxConcurrentJobs);

var app = builder.Build();

ExcelPackage.LicenseContext = LicenseContext.NonCommercial;

var jobs = new ConcurrentDictionary<string, JobState>();

// Template registry: template_id -> { version -> filename }
var templateRegistry = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase)
{
    ["IND_ACQ"] = new Dictionary<string, string>
    {
        ["1.0.0"] = "IND_ACQ_v1.0.0_goldmaster.xlsx"
    },
    ["IND_ACQ_MT"] = new Dictionary<string, string>
    {
        ["1.0.0"] = "IND_ACQ_MT_v1.0.0_goldmaster.xlsx"
    }
};

// Default template IDs
const string TEMPLATE_SINGLE_TENANT = "IND_ACQ";
const string TEMPLATE_MULTI_TENANT = "IND_ACQ_MT";
const int MULTI_TENANT_THRESHOLD = 2; // 2+ tenants = multi-tenant template

app.MapGet("/health", () => Results.Ok(new { ok = true }));

app.MapGet("/version", () => Results.Ok(new
{
    service = "excel-engine",
    version = "1.0.0",
    runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
    b2_enabled = b2Client != null
}));

// Debug endpoint to test B2 connectivity (only available when DEBUG=1)
app.MapGet("/debug/b2", async () =>
{
    if (!debugEnabled)
    {
        return Results.NotFound(new { error = "not_found", message = "Debug endpoint not available" });
    }

    if (b2Client == null)
    {
        return Results.BadRequest(new { error = "b2_not_configured", message = "B2 client is not configured" });
    }

    try
    {
        // Test authorization
        var authResult = await b2Client.EnsureAuthorizedAsync();
        if (!authResult.Success)
        {
            return Results.BadRequest(new { error = "b2_auth_failed", message = authResult.Error });
        }

        // Upload a small test file
        var testContent = Encoding.UTF8.GetBytes($"B2 test file created at {DateTime.UtcNow:O}");
        var testKey = $"test/debug-{DateTime.UtcNow:yyyyMMdd-HHmmss}.txt";

        var uploadResult = await b2Client.UploadFileAsync(testKey, testContent, "text/plain");
        if (!uploadResult.Success)
        {
            return Results.BadRequest(new { error = "b2_upload_failed", message = uploadResult.Error });
        }

        return Results.Ok(new
        {
            status = "ok",
            message = "B2 upload test successful",
            file_name = testKey,
            download_url = uploadResult.DownloadUrl,
            expires_at = uploadResult.ExpiresAt,
            file_id = uploadResult.FileId
        });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = "b2_test_failed", message = ex.Message });
    }
});

// CORS middleware for widget access
app.Use(async (context, next) =>
{
    context.Response.Headers.Append("Access-Control-Allow-Origin", "*");
    context.Response.Headers.Append("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    context.Response.Headers.Append("Access-Control-Allow-Headers", "Content-Type");

    if (context.Request.Method == "OPTIONS")
    {
        context.Response.StatusCode = 204;
        return;
    }

    await next();
});

// Download endpoint for generated Excel files
app.MapGet("/v1/download", (HttpContext context) =>
{
    var path = context.Request.Query["path"].ToString();
    if (string.IsNullOrWhiteSpace(path))
    {
        return Results.BadRequest(new { error = "missing_path", message = "path query parameter is required." });
    }

    // Security: Only allow files from temp directory
    // Resolve symlinks (on macOS, /var is symlinked to /private/var)
    var tempPath = Path.GetFullPath(Path.GetTempPath());
    var fullPath = Path.GetFullPath(path);

    // Normalize both paths by resolving symlinks if they exist
    if (Directory.Exists(tempPath))
    {
        var tempInfo = new DirectoryInfo(tempPath);
        tempPath = tempInfo.FullName;
    }

    // Handle macOS symlink: /var -> /private/var
    if (fullPath.StartsWith("/private") && !tempPath.StartsWith("/private"))
    {
        tempPath = "/private" + tempPath;
    }
    else if (tempPath.StartsWith("/private") && !fullPath.StartsWith("/private"))
    {
        fullPath = "/private" + fullPath;
    }

    if (!fullPath.StartsWith(tempPath))
    {
        return Results.BadRequest(new { error = "invalid_path", message = "Path must be within temp directory." });
    }

    // Use original path for file access
    var actualPath = Path.GetFullPath(path);
    if (!File.Exists(actualPath))
    {
        return Results.NotFound(new { error = "file_not_found", message = $"File not found: {path}" });
    }

    var fileName = Path.GetFileName(actualPath);
    var fileBytes = File.ReadAllBytes(actualPath);
    return Results.File(fileBytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName);
});

app.MapPost("/v1/ind-acq/build", async (HttpRequest request) =>
{
    BuildRequest buildRequest;
    string? templateIdFromContract = null;
    string? templateVersionTarget = null;
    int tenantCount = 0;

    try
    {
        using var reader = new StreamReader(request.Body);
        var body = await reader.ReadToEndAsync();
        if (string.IsNullOrWhiteSpace(body))
        {
            return Results.BadRequest(new { error = "schema_violation", message = "Request body is required." });
        }

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;

        if (!root.TryGetProperty("inputs", out var inputs) || inputs.ValueKind != JsonValueKind.Object)
        {
            return Results.BadRequest(new { error = "schema_violation", message = "inputs must be an object." });
        }

        if (!root.TryGetProperty("mapping", out var mapping) || mapping.ValueKind != JsonValueKind.Object)
        {
            return Results.BadRequest(new { error = "schema_violation", message = "mapping must be an object." });
        }

        // Extract template_id and template_version_target from inputs.contract
        if (inputs.TryGetProperty("contract", out var contract) && contract.ValueKind == JsonValueKind.Object)
        {
            if (contract.TryGetProperty("template_id", out var templateIdElement) && templateIdElement.ValueKind == JsonValueKind.String)
            {
                templateIdFromContract = templateIdElement.GetString();
            }
            if (contract.TryGetProperty("template_version_target", out var versionElement) && versionElement.ValueKind == JsonValueKind.String)
            {
                templateVersionTarget = versionElement.GetString();
            }
        }

        // Count tenants for auto-selection
        if (inputs.TryGetProperty("rent_roll", out var rentRoll) && rentRoll.ValueKind == JsonValueKind.Object)
        {
            if (rentRoll.TryGetProperty("tenants_in_place", out var tenants) && tenants.ValueKind == JsonValueKind.Array)
            {
                tenantCount = tenants.GetArrayLength();
            }
        }

        string? templatePath = null;
        if (root.TryGetProperty("template_path", out var templateElement) && templateElement.ValueKind == JsonValueKind.String)
        {
            templatePath = templateElement.GetString();
        }

        buildRequest = new BuildRequest
        {
            TemplatePath = templatePath,
            Inputs = inputs.Clone(),
            Mapping = mapping.Clone()
        };
    }
    catch (JsonException jsonEx)
    {
        return Results.BadRequest(new { error = "schema_violation", message = $"Invalid JSON: {jsonEx.Message}" });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = "schema_violation", message = $"Unable to parse request: {ex.Message}" });
    }

    // Select template: explicit template_id > auto-select based on tenant count
    var selectedTemplateId = templateIdFromContract;
    if (string.IsNullOrEmpty(selectedTemplateId))
    {
        selectedTemplateId = tenantCount >= MULTI_TENANT_THRESHOLD ? TEMPLATE_MULTI_TENANT : TEMPLATE_SINGLE_TENANT;
        LogStructured("INFO", "Auto-selected template", new { tenantCount, templateId = selectedTemplateId });
    }

    // Validate template_id exists
    if (!templateRegistry.TryGetValue(selectedTemplateId, out var templateVersions))
    {
        return Results.BadRequest(new
        {
            error = "template_not_found",
            message = $"Template '{selectedTemplateId}' not found. Available: {string.Join(", ", templateRegistry.Keys)}"
        });
    }

    // Validate template version if specified
    var effectiveVersion = templateVersionTarget ?? "1.0.0"; // Default to 1.0.0
    if (!templateVersions.ContainsKey(effectiveVersion))
    {
        return Results.BadRequest(new
        {
            error = "template_version_mismatch",
            message = $"Template version '{effectiveVersion}' not available for {selectedTemplateId}. Available: {string.Join(", ", templateVersions.Keys)}"
        });
    }

    // Resolve template path
    var selectedTemplateFilename = templateVersions[effectiveVersion];
    var resolvedTemplatePath = buildRequest.TemplatePath ?? ResolveTemplatePath(selectedTemplateFilename);
    buildRequest = buildRequest with { TemplatePath = resolvedTemplatePath };

    LogStructured("INFO", "Template selected", new
    {
        templateId = selectedTemplateId,
        version = effectiveVersion,
        tenantCount,
        templatePath = resolvedTemplatePath
    });

    // Check concurrency limit
    if (!await jobSemaphore.WaitAsync(0))
    {
        return Results.Json(new
        {
            error = "server_busy",
            message = $"Maximum concurrent jobs ({maxConcurrentJobs}) reached. Please try again later."
        }, statusCode: 503);
    }

    var jobId = Guid.NewGuid().ToString("N");
    var job = new JobState { Status = JobStatus.Pending };
    jobs[jobId] = job;

    _ = Task.Run(async () =>
    {
        try
        {
            await RunJobAsync(jobId, job, buildRequest, b2Client);
        }
        finally
        {
            jobSemaphore.Release();
        }
    });

    return Results.Ok(new { job_id = jobId });
});

app.MapGet("/v1/jobs/{jobId}", (string jobId) =>
{
    if (!jobs.TryGetValue(jobId, out var job))
    {
        return Results.NotFound(new { error = "job_not_found" });
    }

    return Results.Ok(new
    {
        status = job.Status,
        outputs = job.Outputs,
        error = job.Error,
        file_path = job.FilePath,
        download_url = job.DownloadUrl,
        download_url_expiry = job.DownloadUrlExpiry
    });
});

app.Run();

static async Task RunJobAsync(string jobId, JobState job, BuildRequest request, B2Client? b2Client)
{
    job.Status = JobStatus.Running;

    try
    {
        var templatePath = ResolveTemplatePath(request.TemplatePath);
        if (!File.Exists(templatePath))
        {
            throw new InvalidOperationException($"Template file not found: {templatePath}");
        }

        var mapping = request.Mapping;
        if (!mapping.TryGetProperty("named_ranges", out var namedRangesElement))
        {
            throw new InvalidOperationException("Schema violation: mapping.named_ranges is required.");
        }

        if (!mapping.TryGetProperty("tables", out var tablesElement))
        {
            throw new InvalidOperationException("Schema violation: mapping.tables is required.");
        }

        if (!mapping.TryGetProperty("output_named_ranges", out var outputNamedRangesElement))
        {
            throw new InvalidOperationException("Schema violation: mapping.output_named_ranges is required.");
        }

        using var package = new ExcelPackage(new FileInfo(templatePath));

        foreach (var spec in EnumerateNamedRanges(namedRangesElement))
        {
            // Skip if input path doesn't exist (optional mapping)
            if (!TryGetScalarValueByPath(request.Inputs, spec.Path, out var value))
            {
                continue;
            }

            // Support direct cell references like "Assumptions!$P$27" or named ranges
            if (spec.Name.Contains("!"))
            {
                // Direct cell reference - parse sheet and cell
                var parts = spec.Name.Split('!');
                var sheetName = parts[0].Trim('\'');
                var cellRef = parts[1].Replace("$", "");
                var worksheet = package.Workbook.Worksheets[sheetName];
                if (worksheet != null)
                {
                    worksheet.Cells[cellRef].Value = value;
                }
            }
            else
            {
                var namedRange = FindNamedRange(package, spec.Name);
                if (namedRange == null)
                {
                    // Skip if named range doesn't exist in template (optional)
                    continue;
                }
                namedRange.Value = value;
            }
        }

        WriteRentRollTables(request.Inputs, package, tablesElement);

        // Clear renovation budget costs - template has pre-filled values that don't apply to all deals
        // For stabilized acquisitions (IND_ACQ), renovation costs should typically be zero
        var renovationSheet = package.Workbook.Worksheets["Renovation Budget"];
        if (renovationSheet != null)
        {
            // Clear cost cells (column C) for renovation line items
            // These rows have template defaults that inflate the investment costs
            int[] renovationRows = { 22, 27, 28, 29, 30 };  // Hard costs, soft costs, contingency
            foreach (var row in renovationRows)
            {
                renovationSheet.Cells[row, 3].Value = 0;  // Column C = cost
            }
        }

        // Fix: The template has hardcoded Forward 12-month NOI (F30) which should be a formula
        // that calculates from Monthly CF. Set it to a formula that sums 12 months of NOI
        // starting from the exit month (E28).
        var assumptionsSheet = package.Workbook.Worksheets["Assumptions"];
        if (assumptionsSheet != null)
        {
            // F30 should sum the trailing 12 months of NOI ending at the exit month
            // For exit at month 60, this sums months 49-60 (the last 12 months)
            // We also apply the rent growth factor to project forward NOI for the buyer
            // Formula: SUM(OFFSET('Monthly CF'!$D$56,0,$E$28-11,1,12)) * (1 + infl_other_revenue)
            assumptionsSheet.Cells["F30"].Formula = "SUM(OFFSET('Monthly CF'!$D$56,0,$E$28-11,1,12))*(1+infl_other_revenue)";
        }

        package.Workbook.Calculate();

        // Validate layout invariants for PDF fidelity
        var layoutWarnings = ValidateLayoutInvariants(package);

        // Fix: EPPlus incorrectly calculates Building Purchase (D76) as positive instead of negative
        // The formula is =IF(D$11=0,-Assumptions!$F$24,0) but EPPlus returns positive value
        var mcf = package.Workbook.Worksheets["Monthly CF"];
        if (mcf != null && assumptionsSheet != null)
        {
            var d76 = mcf.Cells["D76"].Value;
            var f24 = assumptionsSheet.Cells["F24"].Value;
            if (d76 is double d76Val && d76Val > 0 && f24 is double f24Val)
            {
                mcf.Cells["D76"].Value = -f24Val;
                package.Workbook.Calculate();
            }
        }

        var outputs = new Dictionary<string, object?>();
        foreach (var outputSpec in EnumerateOutputRanges(outputNamedRangesElement))
        {
            var namedRange = FindNamedRange(package, outputSpec.Name);
            if (namedRange == null)
            {
                throw new InvalidOperationException($"Missing named range: {outputSpec.Name}");
            }

            outputs[outputSpec.Key] = ExtractNamedRangeValue(namedRange);
        }

        // Add layout invariant check results
        outputs["out.layout.warning_count"] = layoutWarnings.Count;
        outputs["out.layout.status"] = layoutWarnings.Count == 0 ? "OK" : "WARNINGS";
        if (layoutWarnings.Count > 0)
        {
            outputs["out.layout.warnings"] = string.Join("; ", layoutWarnings);
            LogStructured("WARN", "Layout invariant warnings", new { count = layoutWarnings.Count, warnings = layoutWarnings });
        }

        var outputPath = BuildOutputPath(jobId);
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        package.SaveAs(new FileInfo(outputPath));

        job.Outputs = outputs;
        job.FilePath = outputPath;

        // Upload to Backblaze B2 if configured
        if (b2Client != null)
        {
            try
            {
                var b2Key = $"runs/{jobId}/IND_ACQ.xlsx";
                LogStructured("INFO", "B2 upload starting", new { jobId, key = b2Key });

                var fileBytes = await File.ReadAllBytesAsync(outputPath);
                var uploadResult = await b2Client.UploadFileAsync(
                    b2Key,
                    fileBytes,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                );

                if (uploadResult.Success)
                {
                    LogStructured("INFO", "B2 upload successful", new
                    {
                        jobId,
                        key = b2Key,
                        fileId = uploadResult.FileId,
                        downloadUrl = MaskUrlToken(uploadResult.DownloadUrl),
                        expiresAt = uploadResult.ExpiresAt?.ToString("O")
                    });
                    job.DownloadUrl = uploadResult.DownloadUrl;
                    job.DownloadUrlExpiry = uploadResult.ExpiresAt ?? DateTime.UtcNow.AddHours(1);

                    // Clean up temp file after successful B2 upload
                    try
                    {
                        var tempDir = Path.GetDirectoryName(outputPath);
                        if (tempDir != null && Directory.Exists(tempDir))
                        {
                            Directory.Delete(tempDir, recursive: true);
                            LogStructured("INFO", "Temp files cleaned up", new { jobId, path = tempDir });
                        }
                    }
                    catch (Exception cleanupEx)
                    {
                        LogStructured("WARN", "Temp file cleanup failed", new { jobId, error = cleanupEx.Message });
                    }
                }
                else
                {
                    LogStructured("ERROR", "B2 upload failed", new { jobId, error = uploadResult.Error });
                }
            }
            catch (Exception ex)
            {
                LogStructured("ERROR", "B2 upload exception", new { jobId, error = ex.Message });
            }
        }

        job.Status = JobStatus.Complete;
    }
    catch (Exception ex)
    {
        job.Error = ex.Message;
        job.Status = JobStatus.Failed;
    }
}

static string ResolveTemplatePath(string templateFilename)
{
    // If it's already a full path, use it directly
    if (Path.IsPathRooted(templateFilename) && File.Exists(templateFilename))
    {
        return templateFilename;
    }

    // Check multiple locations for templates:
    // 1. ./templates (Docker production)
    // 2. ../../templates (local development from services/excel-engine)
    var candidates = new[]
    {
        Path.Combine(Directory.GetCurrentDirectory(), "templates", templateFilename),
        Path.Combine(Directory.GetCurrentDirectory(), "..", "..", "templates", templateFilename),
    };

    foreach (var candidate in candidates)
    {
        var fullPath = Path.GetFullPath(candidate);
        if (File.Exists(fullPath))
        {
            return fullPath;
        }
    }

    // Default to Docker path (will fail with clear error if missing)
    return Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "templates", templateFilename));
}

static string BuildOutputPath(string jobId)
{
    return Path.Combine(Path.GetTempPath(), "ind_acq", jobId, "IND_ACQ.xlsx");
}

static ExcelNamedRange? FindNamedRange(ExcelPackage package, string name)
{
    // EPPlus 7.x throws KeyNotFoundException instead of returning null
    if (package.Workbook.Names.ContainsKey(name))
    {
        return package.Workbook.Names[name];
    }

    foreach (var worksheet in package.Workbook.Worksheets)
    {
        if (worksheet.Names.ContainsKey(name))
        {
            return worksheet.Names[name];
        }
    }

    return null;
}

static object? ExtractNamedRangeValue(ExcelNamedRange namedRange)
{
    var value = namedRange.Value;
    if (value is Array array && array.Length > 0)
    {
        return array.GetValue(0);
    }

    return value;
}

static IEnumerable<NamedRangeSpec> EnumerateNamedRanges(JsonElement element)
{
    if (element.ValueKind == JsonValueKind.Object)
    {
        foreach (var property in element.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.String)
            {
                var name = property.Value.GetString();
                if (string.IsNullOrWhiteSpace(name))
                {
                    throw new InvalidOperationException($"Schema violation: mapping.named_ranges.{property.Name} must be a string or object.");
                }

                yield return new NamedRangeSpec(property.Name, name, property.Name);
            }
            else if (property.Value.ValueKind == JsonValueKind.Object)
            {
                var name = GetStringProperty(property.Value, new[] { "name", "excel_name", "defined_name" });
                if (string.IsNullOrWhiteSpace(name))
                {
                    throw new InvalidOperationException($"Schema violation: mapping.named_ranges.{property.Name}.name is required.");
                }

                var path = GetStringProperty(property.Value, new[] { "path", "json_path", "input_path" }) ?? property.Name;
                yield return new NamedRangeSpec(property.Name, name, path);
            }
            else
            {
                throw new InvalidOperationException($"Schema violation: mapping.named_ranges.{property.Name} must be a string or object.");
            }
        }

        yield break;
    }

    if (element.ValueKind == JsonValueKind.Array)
    {
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException("Schema violation: mapping.named_ranges array items must be objects.");
            }

            var key = GetStringProperty(item, new[] { "key", "contract_key" });
            var name = GetStringProperty(item, new[] { "name", "excel_name", "defined_name" });
            var path = GetStringProperty(item, new[] { "path", "json_path", "input_path" }) ?? key;

            if (string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(path))
            {
                throw new InvalidOperationException("Schema violation: mapping.named_ranges array items require key, name, and path.");
            }

            yield return new NamedRangeSpec(key, name, path);
        }

        yield break;
    }

    throw new InvalidOperationException("Schema violation: mapping.named_ranges must be an object or array.");
}

static IEnumerable<NamedRangeSpec> EnumerateOutputRanges(JsonElement element)
{
    if (element.ValueKind == JsonValueKind.Object)
    {
        foreach (var property in element.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.String)
            {
                var name = property.Value.GetString();
                if (string.IsNullOrWhiteSpace(name))
                {
                    throw new InvalidOperationException($"Schema violation: mapping.output_named_ranges.{property.Name} must be a string or object.");
                }

                yield return new NamedRangeSpec(property.Name, name, property.Name);
            }
            else if (property.Value.ValueKind == JsonValueKind.Object)
            {
                var name = GetStringProperty(property.Value, new[] { "name", "excel_name", "defined_name" });
                if (string.IsNullOrWhiteSpace(name))
                {
                    throw new InvalidOperationException($"Schema violation: mapping.output_named_ranges.{property.Name}.name is required.");
                }

                yield return new NamedRangeSpec(property.Name, name, property.Name);
            }
            else
            {
                throw new InvalidOperationException($"Schema violation: mapping.output_named_ranges.{property.Name} must be a string or object.");
            }
        }

        yield break;
    }

    if (element.ValueKind == JsonValueKind.Array)
    {
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException("Schema violation: mapping.output_named_ranges array items must be objects.");
            }

            var key = GetStringProperty(item, new[] { "key", "contract_key" });
            var name = GetStringProperty(item, new[] { "name", "excel_name", "defined_name" });

            if (string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(name))
            {
                throw new InvalidOperationException("Schema violation: mapping.output_named_ranges array items require key and name.");
            }

            yield return new NamedRangeSpec(key, name, key);
        }

        yield break;
    }

    throw new InvalidOperationException("Schema violation: mapping.output_named_ranges must be an object or array.");
}

static string? GetStringProperty(JsonElement element, IEnumerable<string> names)
{
    foreach (var name in names)
    {
        if (element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
        {
            return value.GetString();
        }
    }

    return null;
}

static bool TryGetScalarValueByPath(JsonElement root, string path, out object? value)
{
    value = null;
    if (!TryResolvePath(root, path, out var element))
    {
        return false;
    }
    value = ConvertScalar(element, path);
    return true;
}

static bool TryResolvePath(JsonElement root, string path, out JsonElement element)
{
    element = default;

    if (string.IsNullOrWhiteSpace(path))
    {
        throw new InvalidOperationException("Schema violation: JSON path cannot be empty.");
    }

    var normalized = path.Trim();
    if (normalized.StartsWith("$") && normalized.Length > 1)
    {
        normalized = normalized.TrimStart('$').TrimStart('.');
    }

    var current = root;
    var segments = SplitPath(normalized);

    foreach (var segment in segments)
    {
        if (segment.IsIndex)
        {
            if (current.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidOperationException($"Schema violation: expected array at '{segment.Raw}'.");
            }

            if (segment.Index < 0 || segment.Index >= current.GetArrayLength())
            {
                throw new InvalidOperationException($"Schema violation: array index {segment.Index} out of range at '{segment.Raw}'.");
            }

            current = GetArrayElementAt(current, segment.Index);
            continue;
        }

        if (current.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException($"Schema violation: expected object at '{segment.Raw}'.");
        }

        if (!current.TryGetProperty(segment.Property, out var next))
        {
            return false;
        }

        current = next;
    }

    element = current;
    return true;
}

static JsonElement GetArrayElementAt(JsonElement arrayElement, int index)
{
    var enumerator = arrayElement.EnumerateArray();
    var currentIndex = 0;
    while (enumerator.MoveNext())
    {
        if (currentIndex == index)
        {
            return enumerator.Current;
        }
        currentIndex++;
    }

    throw new InvalidOperationException($"Schema violation: array index {index} out of range.");
}

static object? ConvertScalar(JsonElement element, string path)
{
    return element.ValueKind switch
    {
        JsonValueKind.String => element.GetString(),
        JsonValueKind.Number => element.TryGetInt64(out var longValue) ? longValue : element.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Null => null,
        _ => throw new InvalidOperationException($"Schema violation: expected scalar at '{path}'.")
    };
}

static IEnumerable<PathSegment> SplitPath(string path)
{
    var buffer = string.Empty;
    for (var i = 0; i < path.Length; i++)
    {
        var ch = path[i];
        if (ch == '.')
        {
            if (!string.IsNullOrEmpty(buffer))
            {
                yield return new PathSegment(buffer, false, 0, buffer);
                buffer = string.Empty;
            }
            continue;
        }

        if (ch == '[')
        {
            if (!string.IsNullOrEmpty(buffer))
            {
                yield return new PathSegment(buffer, false, 0, buffer);
                buffer = string.Empty;
            }

            var closeIndex = path.IndexOf(']', i + 1);
            if (closeIndex == -1)
            {
                throw new InvalidOperationException($"Schema violation: unterminated index in path '{path}'.");
            }

            var indexToken = path.Substring(i + 1, closeIndex - i - 1);
            if (!int.TryParse(indexToken, out var index))
            {
                throw new InvalidOperationException($"Schema violation: invalid array index '{indexToken}' in path '{path}'.");
            }

            yield return new PathSegment(string.Empty, true, index, $"[{indexToken}]");
            i = closeIndex;
            continue;
        }

        buffer += ch;
    }

    if (!string.IsNullOrEmpty(buffer))
    {
        yield return new PathSegment(buffer, false, 0, buffer);
    }
}

static void WriteRentRollTables(JsonElement inputs, ExcelPackage package, JsonElement tablesElement)
{
    WriteRentRollTable(inputs, package, tablesElement, "rent_roll_in_place", "rent_roll.tenants_in_place", allowMissing: false);
    WriteRentRollTable(inputs, package, tablesElement, "rent_roll_market", "rent_roll.market_rollover", allowMissing: true);
}

static void WriteRentRollTable(
    JsonElement inputs,
    ExcelPackage package,
    JsonElement tablesElement,
    string tableKey,
    string defaultSourcePath,
    bool allowMissing)
{
    if (tablesElement.ValueKind != JsonValueKind.Object)
    {
        throw new InvalidOperationException("Schema violation: mapping.tables must be an object.");
    }

    if (!tablesElement.TryGetProperty(tableKey, out var tableElement) || tableElement.ValueKind != JsonValueKind.Object)
    {
        throw new InvalidOperationException($"Schema violation: mapping.tables.{tableKey} is required.");
    }

    var tableName = GetStringProperty(tableElement, new[] { "table_name", "name" });
    if (string.IsNullOrWhiteSpace(tableName))
    {
        throw new InvalidOperationException($"Schema violation: mapping.tables.{tableKey}.table_name is required.");
    }

    var sourcePath = GetStringProperty(tableElement, new[] { "source_path", "path" }) ?? defaultSourcePath;
    JsonDocument? emptyDoc = null;
    if (!TryResolvePath(inputs, sourcePath, out var rowsElement))
    {
        if (!allowMissing)
        {
            throw new InvalidOperationException($"Schema violation: missing path '{sourcePath}'.");
        }

        emptyDoc = JsonDocument.Parse("[]");
        rowsElement = emptyDoc.RootElement;
    }

    if (rowsElement.ValueKind != JsonValueKind.Array)
    {
        throw new InvalidOperationException($"Schema violation: {sourcePath} must be an array.");
    }

    var rows = rowsElement.EnumerateArray().ToArray();
    var table = FindTable(package, tableName);
    if (table == null)
    {
        throw new InvalidOperationException($"Missing table: {tableName}");
    }

    var tableRange = table.Range;
    if (tableRange == null)
    {
        throw new InvalidOperationException($"Table {tableName} has no range.");
    }

    var availableRows = tableRange.Rows - 1; // Exclude header row
    var inputRows = rows.Length;
    if (inputRows > availableRows)
    {
        throw new InvalidOperationException(
            $"Table {tableName} has {availableRows} rows but received {inputRows} rows.");
    }

    ClearTableData(table);

    var columnMapping = BuildColumnMapping(table, tableElement);

    for (var rowIndex = 0; rowIndex < inputRows; rowIndex++)
    {
        var rowElement = rows[rowIndex];
        if (rowElement.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException($"Schema violation: {sourcePath}[{rowIndex}] must be an object.");
        }

        WriteTableRow(table, rowIndex, rowElement, columnMapping);
    }

    emptyDoc?.Dispose();
}

static ExcelTable? FindTable(ExcelPackage package, string tableName)
{
    foreach (var worksheet in package.Workbook.Worksheets)
    {
        var table = worksheet.Tables.FirstOrDefault(t =>
            string.Equals(t.Name, tableName, StringComparison.OrdinalIgnoreCase));
        if (table != null)
        {
            return table;
        }
    }

    return null;
}

static void ClearTableData(ExcelTable table)
{
    var tableRange = table.Range;
    if (tableRange == null || tableRange.Rows <= 1)
    {
        return;
    }

    // Data rows start at row 2 (after header)
    var dataRows = tableRange.Rows - 1;
    var columns = tableRange.Columns;
    var startRow = tableRange.Start.Row + 1; // Skip header
    var startCol = tableRange.Start.Column;

    var worksheet = tableRange.Worksheet;
    for (var row = 0; row < dataRows; row++)
    {
        for (var col = 0; col < columns; col++)
        {
            worksheet.Cells[startRow + row, startCol + col].Value = null;
        }
    }
}

static Dictionary<string, int> BuildColumnMapping(ExcelTable table, JsonElement tableElement)
{
    var mapping = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

    if (tableElement.TryGetProperty("columns", out var columnsElement))
    {
        if (columnsElement.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in columnsElement.EnumerateObject())
            {
                var columnIndex = ResolveColumnIndex(table, property.Value);
                mapping[property.Name] = columnIndex;
            }
        }
        else if (columnsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in columnsElement.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object)
                {
                    throw new InvalidOperationException("Schema violation: mapping.tables.*.columns array items must be objects.");
                }

                var key = GetStringProperty(item, new[] { "key", "input_key" });
                if (string.IsNullOrWhiteSpace(key))
                {
                    throw new InvalidOperationException("Schema violation: mapping.tables.*.columns items require key.");
                }

                var columnIndex = ResolveColumnIndex(table, item);
                mapping[key] = columnIndex;
            }
        }
        else
        {
            throw new InvalidOperationException("Schema violation: mapping.tables.*.columns must be an object or array.");
        }
    }
    else if (tableElement.ValueKind == JsonValueKind.Object)
    {
        foreach (var property in tableElement.EnumerateObject())
        {
            if (string.Equals(property.Name, "table_name", StringComparison.OrdinalIgnoreCase)
                || string.Equals(property.Name, "name", StringComparison.OrdinalIgnoreCase)
                || string.Equals(property.Name, "source_path", StringComparison.OrdinalIgnoreCase)
                || string.Equals(property.Name, "path", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (property.Value.ValueKind != JsonValueKind.String)
            {
                throw new InvalidOperationException("Schema violation: mapping.tables.* column mappings must be strings.");
            }

            var header = property.Value.GetString();
            if (string.IsNullOrWhiteSpace(header))
            {
                throw new InvalidOperationException("Schema violation: mapping.tables.* column mapping values cannot be empty.");
            }

            mapping[property.Name] = FindColumnIndexByHeader(table, header);
        }
    }

    return mapping;
}

static int ResolveColumnIndex(ExcelTable table, JsonElement columnElement)
{
    if (columnElement.ValueKind == JsonValueKind.Number && columnElement.TryGetInt32(out var index))
    {
        return ValidateColumnIndex(table, index);
    }

    if (columnElement.ValueKind == JsonValueKind.String)
    {
        var header = columnElement.GetString();
        if (string.IsNullOrWhiteSpace(header))
        {
            throw new InvalidOperationException("Schema violation: column header cannot be empty.");
        }

        return FindColumnIndexByHeader(table, header);
    }

    if (columnElement.ValueKind == JsonValueKind.Object)
    {
        if (columnElement.TryGetProperty("index", out var indexElement) && indexElement.TryGetInt32(out var indexValue))
        {
            return ValidateColumnIndex(table, indexValue);
        }

        if (columnElement.TryGetProperty("column", out var columnElementValue) && columnElementValue.TryGetInt32(out var columnIndex))
        {
            return ValidateColumnIndex(table, columnIndex);
        }

        var header = GetStringProperty(columnElement, new[] { "header", "name" });
        if (!string.IsNullOrWhiteSpace(header))
        {
            return FindColumnIndexByHeader(table, header);
        }
    }

    throw new InvalidOperationException("Schema violation: unable to resolve table column mapping.");
}

static int ValidateColumnIndex(ExcelTable table, int index)
{
    if (index < 1 || index > table.Columns.Count)
    {
        throw new InvalidOperationException($"Schema violation: column index {index} is out of range for table {table.Name}.");
    }

    return index;
}

static int FindColumnIndexByHeader(ExcelTable table, string header)
{
    for (var i = 0; i < table.Columns.Count; i++)
    {
        var tableHeader = table.Columns[i].Name;
        if (string.Equals(tableHeader, header, StringComparison.OrdinalIgnoreCase))
        {
            return i + 1;
        }
    }

    throw new InvalidOperationException($"Missing column header '{header}' in table {table.Name}.");
}

static void WriteTableRow(ExcelTable table, int rowIndex, JsonElement rowElement, Dictionary<string, int> explicitMapping)
{
    var tableRange = table.Range;
    if (tableRange == null || tableRange.Rows <= 1)
    {
        return;
    }

    var worksheet = tableRange.Worksheet;
    var dataStartRow = tableRange.Start.Row + 1; // Skip header
    var startCol = tableRange.Start.Column;
    var targetRow = dataStartRow + rowIndex;

    if (explicitMapping.Count > 0)
    {
        foreach (var mapping in explicitMapping)
        {
            if (rowElement.TryGetProperty(mapping.Key, out var valueElement))
            {
                worksheet.Cells[targetRow, startCol + mapping.Value - 1].Value = ConvertScalar(valueElement, mapping.Key);
                continue;
            }

            if (TryResolveNestedValue(rowElement, mapping.Key, out var nestedValue))
            {
                worksheet.Cells[targetRow, startCol + mapping.Value - 1].Value = ConvertScalar(nestedValue, mapping.Key);
            }
        }

        return;
    }

    var normalizedValues = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
    foreach (var property in rowElement.EnumerateObject())
    {
        normalizedValues[NormalizeKey(property.Name)] = property.Value;
    }

    for (var colIndex = 0; colIndex < table.Columns.Count; colIndex++)
    {
        var header = table.Columns[colIndex].Name;
        var key = NormalizeKey(header);
        if (normalizedValues.TryGetValue(key, out var valueElement))
        {
            worksheet.Cells[targetRow, startCol + colIndex].Value = ConvertScalar(valueElement, header);
        }
    }
}

static string NormalizeKey(string value)
{
    var buffer = new char[value.Length];
    var length = 0;

    foreach (var ch in value)
    {
        if (char.IsLetterOrDigit(ch))
        {
            buffer[length++] = char.ToLowerInvariant(ch);
        }
    }

    return new string(buffer, 0, length);
}

static bool TryResolveNestedValue(JsonElement rowElement, string key, out JsonElement value)
{
    value = default;

    if (key.StartsWith("ti_", StringComparison.OrdinalIgnoreCase))
    {
        return TryResolveNestedProperty(rowElement, "ti", key[3..], out value);
    }

    if (key.StartsWith("lc_", StringComparison.OrdinalIgnoreCase))
    {
        return TryResolveNestedProperty(rowElement, "lc", key[3..], out value);
    }

    return false;
}

static bool TryResolveNestedProperty(JsonElement rowElement, string objectKey, string propertyKey, out JsonElement value)
{
    value = default;
    if (!rowElement.TryGetProperty(objectKey, out var nested) || nested.ValueKind != JsonValueKind.Object)
    {
        return false;
    }

    if (!nested.TryGetProperty(propertyKey, out var nestedValue))
    {
        return false;
    }

    value = nestedValue;
    return true;
}

// ============================================================================
// Backblaze B2 Native API Client
// ============================================================================

sealed class B2Client
{
    private readonly string _keyId;
    private readonly string _appKey;
    private readonly string _bucketId;
    private readonly string? _bucketName;
    private readonly string? _downloadUrlOverride;
    private readonly int _authCacheTtlSeconds;
    private readonly int _downloadAuthTtlSeconds;
    private readonly HttpClient _httpClient;
    private readonly SemaphoreSlim _authLock = new(1, 1);

    private B2AuthResponse? _cachedAuth;
    private DateTime _authExpiry = DateTime.MinValue;

    public B2Client(string keyId, string appKey, string bucketId, string? bucketName, string? downloadUrlOverride, int authCacheTtlSeconds, int downloadAuthTtlSeconds)
    {
        _keyId = keyId;
        _appKey = appKey;
        _bucketId = bucketId;
        _bucketName = bucketName;
        _downloadUrlOverride = downloadUrlOverride;
        _authCacheTtlSeconds = authCacheTtlSeconds;
        _downloadAuthTtlSeconds = downloadAuthTtlSeconds;
        _httpClient = new HttpClient();
    }

    public async Task<(bool Success, string? Error)> EnsureAuthorizedAsync()
    {
        await _authLock.WaitAsync();
        try
        {
            if (_cachedAuth != null && DateTime.UtcNow < _authExpiry)
            {
                return (true, null);
            }

            var authResult = await AuthorizeAsync();
            if (!authResult.Success)
            {
                return (false, authResult.Error);
            }

            _cachedAuth = authResult.Response;
            _authExpiry = DateTime.UtcNow.AddSeconds(_authCacheTtlSeconds);
            return (true, null);
        }
        finally
        {
            _authLock.Release();
        }
    }

    private async Task<(bool Success, B2AuthResponse? Response, string? Error)> AuthorizeAsync()
    {
        try
        {
            var authString = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{_keyId}:{_appKey}"));

            using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.backblazeb2.com/b2api/v2/b2_authorize_account");
            request.Headers.Authorization = new AuthenticationHeaderValue("Basic", authString);

            var response = await _httpClient.SendAsync(request);
            var responseBody = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                var errorResponse = JsonSerializer.Deserialize<B2ErrorResponse>(responseBody);
                return (false, null, $"B2 auth failed: {errorResponse?.Code} - {errorResponse?.Message}");
            }

            var authResponse = JsonSerializer.Deserialize<B2AuthResponse>(responseBody);
            if (authResponse == null)
            {
                return (false, null, "B2 auth failed: empty response");
            }

            // Log auth success without sensitive token data
            Console.WriteLine($"{{\"timestamp\":\"{DateTime.UtcNow:O}\",\"level\":\"INFO\",\"message\":\"B2 authorized\",\"data\":{{\"apiUrl\":\"{authResponse.ApiUrl}\",\"downloadUrl\":\"{authResponse.DownloadUrl}\"}}}}");
            return (true, authResponse, null);
        }
        catch (Exception ex)
        {
            return (false, null, $"B2 auth exception: {ex.Message}");
        }
    }

    public async Task<B2UploadResult> UploadFileAsync(string fileName, byte[] fileData, string contentType)
    {
        // Ensure we're authorized
        var authResult = await EnsureAuthorizedAsync();
        if (!authResult.Success)
        {
            return new B2UploadResult { Success = false, Error = authResult.Error };
        }

        // Get upload URL
        var uploadUrlResult = await GetUploadUrlAsync();
        if (!uploadUrlResult.Success)
        {
            return new B2UploadResult { Success = false, Error = uploadUrlResult.Error };
        }

        // Upload the file
        try
        {
            using var sha1 = SHA1.Create();
            var sha1Hash = BitConverter.ToString(sha1.ComputeHash(fileData)).Replace("-", "").ToLowerInvariant();

            using var request = new HttpRequestMessage(HttpMethod.Post, uploadUrlResult.UploadUrl);
            // B2 uses raw token, not "scheme token" format
            request.Headers.TryAddWithoutValidation("Authorization", uploadUrlResult.AuthToken);
            request.Headers.TryAddWithoutValidation("X-Bz-File-Name", Uri.EscapeDataString(fileName));
            request.Headers.TryAddWithoutValidation("X-Bz-Content-Sha1", sha1Hash);

            request.Content = new ByteArrayContent(fileData);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
            request.Content.Headers.ContentLength = fileData.Length;

            var response = await _httpClient.SendAsync(request);
            var responseBody = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                var errorResponse = JsonSerializer.Deserialize<B2ErrorResponse>(responseBody);
                return new B2UploadResult
                {
                    Success = false,
                    Error = $"B2 upload failed: {response.StatusCode} - {errorResponse?.Code} - {errorResponse?.Message}"
                };
            }

            var uploadResponse = JsonSerializer.Deserialize<B2UploadFileResponse>(responseBody);
            if (uploadResponse == null)
            {
                return new B2UploadResult { Success = false, Error = "B2 upload failed: empty response" };
            }

            // Generate authorized download URL for private bucket
            var downloadUrl = _downloadUrlOverride ?? _cachedAuth?.DownloadUrl ?? "";
            var baseDownloadUrl = $"{downloadUrl}/file/{_bucketName}/{fileName}";

            // Get download authorization token (TTL configurable via B2_DOWNLOAD_AUTH_TTL_SECONDS)
            var downloadAuthResult = await GetDownloadAuthorizationAsync(fileName, _downloadAuthTtlSeconds);
            string fullDownloadUrl;
            DateTime? expiresAt = null;

            if (downloadAuthResult.Success && !string.IsNullOrEmpty(downloadAuthResult.AuthToken))
            {
                fullDownloadUrl = $"{baseDownloadUrl}?Authorization={Uri.EscapeDataString(downloadAuthResult.AuthToken)}";
                expiresAt = DateTime.UtcNow.AddSeconds(downloadAuthResult.ValidDurationSeconds);
            }
            else
            {
                // Fallback to base URL (will only work for public buckets)
                fullDownloadUrl = baseDownloadUrl;
                Console.WriteLine($"{{\"timestamp\":\"{DateTime.UtcNow:O}\",\"level\":\"WARN\",\"message\":\"Could not get download authorization\",\"data\":{{\"error\":\"{downloadAuthResult.Error?.Replace("\"", "\\\"")}\"}}}}");
            }

            return new B2UploadResult
            {
                Success = true,
                FileId = uploadResponse.FileId,
                FileName = uploadResponse.FileName,
                DownloadUrl = fullDownloadUrl,
                ExpiresAt = expiresAt
            };
        }
        catch (Exception ex)
        {
            return new B2UploadResult { Success = false, Error = $"B2 upload exception: {ex.Message}" };
        }
    }

    private async Task<(bool Success, string? UploadUrl, string? AuthToken, string? Error)> GetUploadUrlAsync()
    {
        if (_cachedAuth == null)
        {
            return (false, null, null, "Not authorized");
        }

        try
        {
            var requestBody = JsonSerializer.Serialize(new { bucketId = _bucketId });

            using var request = new HttpRequestMessage(HttpMethod.Post, $"{_cachedAuth.ApiUrl}/b2api/v2/b2_get_upload_url");
            request.Headers.TryAddWithoutValidation("Authorization", _cachedAuth.AuthorizationToken);
            request.Content = new StringContent(requestBody, Encoding.UTF8, "application/json");

            var response = await _httpClient.SendAsync(request);
            var responseBody = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                var errorResponse = JsonSerializer.Deserialize<B2ErrorResponse>(responseBody);
                return (false, null, null, $"B2 get_upload_url failed: {errorResponse?.Code} - {errorResponse?.Message}");
            }

            var uploadUrlResponse = JsonSerializer.Deserialize<B2UploadUrlResponse>(responseBody);
            if (uploadUrlResponse == null)
            {
                return (false, null, null, "B2 get_upload_url failed: empty response");
            }

            return (true, uploadUrlResponse.UploadUrl, uploadUrlResponse.AuthorizationToken, null);
        }
        catch (Exception ex)
        {
            return (false, null, null, $"B2 get_upload_url exception: {ex.Message}");
        }
    }

    private async Task<(bool Success, string? AuthToken, int ValidDurationSeconds, string? Error)> GetDownloadAuthorizationAsync(string fileNamePrefix, int validDurationSeconds = 3600)
    {
        if (_cachedAuth == null)
        {
            return (false, null, 0, "Not authorized");
        }

        try
        {
            var requestBody = JsonSerializer.Serialize(new
            {
                bucketId = _bucketId,
                fileNamePrefix = fileNamePrefix,
                validDurationInSeconds = validDurationSeconds
            });

            using var request = new HttpRequestMessage(HttpMethod.Post, $"{_cachedAuth.ApiUrl}/b2api/v2/b2_get_download_authorization");
            request.Headers.TryAddWithoutValidation("Authorization", _cachedAuth.AuthorizationToken);
            request.Content = new StringContent(requestBody, Encoding.UTF8, "application/json");

            var response = await _httpClient.SendAsync(request);
            var responseBody = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                var errorResponse = JsonSerializer.Deserialize<B2ErrorResponse>(responseBody);
                return (false, null, 0, $"B2 get_download_authorization failed: {errorResponse?.Code} - {errorResponse?.Message}");
            }

            var authResponse = JsonSerializer.Deserialize<B2DownloadAuthResponse>(responseBody);
            if (authResponse == null || string.IsNullOrEmpty(authResponse.AuthorizationToken))
            {
                return (false, null, 0, "B2 get_download_authorization failed: empty response");
            }

            return (true, authResponse.AuthorizationToken, validDurationSeconds, null);
        }
        catch (Exception ex)
        {
            return (false, null, 0, $"B2 get_download_authorization exception: {ex.Message}");
        }
    }
}

sealed class B2DownloadAuthResponse
{
    [JsonPropertyName("authorizationToken")]
    public string? AuthorizationToken { get; set; }

    [JsonPropertyName("bucketId")]
    public string? BucketId { get; set; }

    [JsonPropertyName("fileNamePrefix")]
    public string? FileNamePrefix { get; set; }
}

// B2 API Response Models
sealed class B2AuthResponse
{
    [JsonPropertyName("accountId")]
    public string? AccountId { get; set; }

    [JsonPropertyName("apiUrl")]
    public string? ApiUrl { get; set; }

    [JsonPropertyName("authorizationToken")]
    public string? AuthorizationToken { get; set; }

    [JsonPropertyName("downloadUrl")]
    public string? DownloadUrl { get; set; }

    [JsonPropertyName("allowed")]
    public B2Allowed? Allowed { get; set; }
}

sealed class B2Allowed
{
    [JsonPropertyName("bucketId")]
    public string? BucketId { get; set; }

    [JsonPropertyName("bucketName")]
    public string? BucketName { get; set; }

    [JsonPropertyName("capabilities")]
    public List<string>? Capabilities { get; set; }
}

sealed class B2ErrorResponse
{
    [JsonPropertyName("code")]
    public string? Code { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("status")]
    public int Status { get; set; }
}

sealed class B2UploadUrlResponse
{
    [JsonPropertyName("bucketId")]
    public string? BucketId { get; set; }

    [JsonPropertyName("uploadUrl")]
    public string? UploadUrl { get; set; }

    [JsonPropertyName("authorizationToken")]
    public string? AuthorizationToken { get; set; }
}

sealed class B2UploadFileResponse
{
    [JsonPropertyName("fileId")]
    public string? FileId { get; set; }

    [JsonPropertyName("fileName")]
    public string? FileName { get; set; }

    [JsonPropertyName("contentSha1")]
    public string? ContentSha1 { get; set; }

    [JsonPropertyName("contentLength")]
    public long ContentLength { get; set; }

    [JsonPropertyName("contentType")]
    public string? ContentType { get; set; }
}

sealed class B2UploadResult
{
    public bool Success { get; set; }
    public string? FileId { get; set; }
    public string? FileName { get; set; }
    public string? DownloadUrl { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public string? Error { get; set; }
}

// ============================================================================
// Domain Models
// ============================================================================

sealed record BuildRequest
{
    public string? TemplatePath { get; init; }
    public JsonElement Inputs { get; init; }
    public JsonElement Mapping { get; init; }
}

sealed class JobState
{
    public string Status { get; set; } = JobStatus.Pending;
    public Dictionary<string, object?>? Outputs { get; set; }
    public string? Error { get; set; }
    public string? FilePath { get; set; }
    public string? DownloadUrl { get; set; }
    public DateTime? DownloadUrlExpiry { get; set; }
}

static class JobStatus
{
    public const string Pending = "pending";
    public const string Running = "running";
    public const string Complete = "complete";
    public const string Failed = "failed";
}

readonly record struct NamedRangeSpec(string Key, string Name, string Path);
readonly record struct PathSegment(string Property, bool IsIndex, int Index, string Raw);

// ============================================================================
// Layout Invariant Validation for PDF Fidelity
// ============================================================================

static List<string> ValidateLayoutInvariants(ExcelPackage package)
{
    var warnings = new List<string>();

    // Required sheets for IND_ACQ template (matches reference PDF structure)
    var requiredSheets = new[]
    {
        "Assumptions",
        "Rent Roll",
        "Monthly CF",
        "Annual Cashflow",
        "Investment Summary"
    };

    // Check required sheets exist
    foreach (var sheetName in requiredSheets)
    {
        var worksheet = package.Workbook.Worksheets[sheetName];
        if (worksheet == null)
        {
            warnings.Add($"Missing required sheet: {sheetName}");
            continue;
        }

        // Check print area is defined
        if (string.IsNullOrEmpty(worksheet.PrinterSettings.PrintArea?.Address))
        {
            warnings.Add($"Missing print area on sheet: {sheetName}");
        }

        // Check freeze panes on data sheets (should have frozen header row)
        if (sheetName is "Monthly CF" or "Rent Roll" or "Annual Cashflow")
        {
            var view = worksheet.View;
            if (view.FreezePanes == false)
            {
                warnings.Add($"Missing freeze panes on sheet: {sheetName}");
            }
        }

        // Validate page setup for key sheets
        ValidatePageSetup(worksheet, sheetName, warnings);
    }

    // Check Investment Summary has reasonable margins for PDF export
    var summarySheet = package.Workbook.Worksheets["Investment Summary"];
    if (summarySheet != null)
    {
        var printer = summarySheet.PrinterSettings;

        // Check paper size (should be Letter/A4)
        if (printer.PaperSize != OfficeOpenXml.ePaperSize.Letter &&
            printer.PaperSize != OfficeOpenXml.ePaperSize.A4)
        {
            warnings.Add($"Investment Summary: Unexpected paper size ({printer.PaperSize})");
        }

        // Check orientation (summary is usually portrait)
        if (printer.Orientation != OfficeOpenXml.eOrientation.Portrait &&
            printer.Orientation != OfficeOpenXml.eOrientation.Landscape)
        {
            warnings.Add("Investment Summary: Page orientation not set");
        }
    }

    return warnings;
}

static void ValidatePageSetup(OfficeOpenXml.ExcelWorksheet worksheet, string sheetName, List<string> warnings)
{
    var printer = worksheet.PrinterSettings;

    // Check margins are reasonable (not zero, not too large)
    // EPPlus uses inches for margins
    const decimal minMargin = 0.25m;
    const decimal maxMargin = 1.5m;

    if (printer.LeftMargin < minMargin || printer.LeftMargin > maxMargin)
    {
        warnings.Add($"{sheetName}: Left margin out of range ({printer.LeftMargin})");
    }
    if (printer.RightMargin < minMargin || printer.RightMargin > maxMargin)
    {
        warnings.Add($"{sheetName}: Right margin out of range ({printer.RightMargin})");
    }
    if (printer.TopMargin < minMargin || printer.TopMargin > maxMargin)
    {
        warnings.Add($"{sheetName}: Top margin out of range ({printer.TopMargin})");
    }
    if (printer.BottomMargin < minMargin || printer.BottomMargin > maxMargin)
    {
        warnings.Add($"{sheetName}: Bottom margin out of range ({printer.BottomMargin})");
    }

    // Check scaling settings (should be FitToPage or a reasonable percentage)
    if (printer.FitToPage)
    {
        // FitToPage is enabled - good for PDF consistency
        if (printer.FitToWidth < 1 || printer.FitToWidth > 3)
        {
            warnings.Add($"{sheetName}: FitToWidth out of range ({printer.FitToWidth})");
        }
        if (printer.FitToHeight < 0 || printer.FitToHeight > 100)
        {
            warnings.Add($"{sheetName}: FitToHeight out of range ({printer.FitToHeight})");
        }
    }
    else
    {
        // Using scale percentage
        if (printer.Scale < 50 || printer.Scale > 100)
        {
            warnings.Add($"{sheetName}: Scale percentage out of range ({printer.Scale}%)");
        }
    }
}
