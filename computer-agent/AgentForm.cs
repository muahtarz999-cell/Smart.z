using System.Buffers;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NSec.Cryptography;
using QRCoder;
using WinForms = System.Windows.Forms;

namespace Smartz.ComputerAgent;

internal sealed class AgentForm : Form
{
    private const string PairingProofPrefix = "smartz-computer-pairing:v1:";
    private static readonly byte[] SpkiEd25519Prefix = Convert.FromHexString("302A300506032B6570032100");
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly TextBox _origin = new() { Width = 370, PlaceholderText = "https://smartz.example" };
    private readonly TextBox _label = new() { Width = 220, Text = Environment.MachineName };
    private readonly ListBox _folders = new() { Width = 410, Height = 82 };
    private readonly ListBox _apps = new() { Width = 410, Height = 82 };
    private readonly ListBox _commands = new() { Width = 410, Height = 82 };
    private readonly List<AgentApp> _appItems = [];
    private readonly List<AgentCommand> _commandItems = [];
    private readonly PictureBox _qr = new() { Width = 260, Height = 260, SizeMode = PictureBoxSizeMode.Zoom };
    private readonly Label _status = new() { AutoSize = true, MaximumSize = new Size(620, 0) };
    private readonly Button _pairButton = new() { Text = "ربط الكمبيوتر عبر QR", AutoSize = true };
    private readonly Button _startButton = new() { Text = "تشغيل استقبال المهام", AutoSize = true, Enabled = false };
    private readonly Button _stopButton = new() { Text = "إيقاف", AutoSize = true, Enabled = false };
    private AgentConfiguration? _configuration;
    private HttpClient? _http;
    private CancellationTokenSource? _workerCancellation;
    private Task? _workerTask;
    private bool _closing;

    public AgentForm()
    {
        Text = "Smart.z — وكيل الكمبيوتر";
        MinimumSize = new Size(680, 680);
        StartPosition = FormStartPosition.CenterScreen;
        RightToLeft = RightToLeft.Yes;
        RightToLeftLayout = true;

        var layout = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            Padding = new Padding(18),
        };
        Controls.Add(layout);

        layout.Controls.Add(new Label
        {
            Text = "يربط هذا التطبيق جهاز Windows بعد موافقة هاتف Smart.z. ينفذ فقط: عمليات الملفات داخل المجلدات المسموحة، فتح المستندات والروابط، والبرامج والأوامر التي تضيفها أنت هنا بالاسم. كل مهمة تحتاج موافقتك من الهاتف.",
            AutoSize = true,
            MaximumSize = new Size(620, 0),
        });
        layout.Controls.Add(new Label { Text = "عنوان Smart.z", AutoSize = true });
        layout.Controls.Add(_origin);
        layout.Controls.Add(new Label { Text = "اسم الكمبيوتر", AutoSize = true });
        layout.Controls.Add(_label);
        layout.Controls.Add(new Label { Text = "المجلدات المسموح بها محليًا (اخترها على هذا الكمبيوتر)", AutoSize = true });
        layout.Controls.Add(_folders);

        var folderButtons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft };
        var addFolder = new Button { Text = "إضافة مجلد", AutoSize = true };
        var removeFolder = new Button { Text = "إزالة المحدد", AutoSize = true };
        addFolder.Click += (_, _) => AddFolder();
        removeFolder.Click += (_, _) => RemoveFolder();
        folderButtons.Controls.Add(addFolder);
        folderButtons.Controls.Add(removeFolder);
        layout.Controls.Add(folderButtons);

        layout.Controls.Add(new Label { Text = "البرامج المسموح للهاتف بفتحها (بالاسم)", AutoSize = true });
        layout.Controls.Add(_apps);
        var appButtons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft };
        var addApp = new Button { Text = "إضافة برنامج", AutoSize = true };
        var removeApp = new Button { Text = "إزالة المحدد", AutoSize = true };
        addApp.Click += (_, _) => AddApp();
        removeApp.Click += (_, _) => RemoveSelected(_apps, _appItems);
        appButtons.Controls.Add(addApp);
        appButtons.Controls.Add(removeApp);
        layout.Controls.Add(appButtons);

        layout.Controls.Add(new Label { Text = "الأوامر المسموح للهاتف بتشغيلها (بالاسم، مع عرض ناتجها)", AutoSize = true });
        layout.Controls.Add(_commands);
        var commandButtons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft };
        var addCommand = new Button { Text = "إضافة أمر", AutoSize = true };
        var removeCommand = new Button { Text = "إزالة المحدد", AutoSize = true };
        addCommand.Click += (_, _) => AddCommand();
        removeCommand.Click += (_, _) => RemoveSelected(_commands, _commandItems);
        commandButtons.Controls.Add(addCommand);
        commandButtons.Controls.Add(removeCommand);
        layout.Controls.Add(commandButtons);

        var agentButtons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft };
        _pairButton.Click += async (_, _) => await PairAsync();
        _startButton.Click += (_, _) => StartWorker();
        _stopButton.Click += async (_, _) => await StopWorkerAsync();
        agentButtons.Controls.Add(_pairButton);
        agentButtons.Controls.Add(_startButton);
        agentButtons.Controls.Add(_stopButton);
        layout.Controls.Add(agentButtons);
        layout.Controls.Add(_qr);
        layout.Controls.Add(_status);

        LoadConfiguration();
        FormClosing += OnFormClosing;
    }

    private void LoadConfiguration()
    {
        try
        {
            _configuration = AgentConfiguration.Load();
            if (_configuration is null)
            {
                SetStatus("اختر مجلدًا محليًا واحدًا على الأقل، ثم اربط الكمبيوتر بهاتفك.");
                return;
            }

            _origin.Text = _configuration.Origin;
            _label.Text = _configuration.Label;
            foreach (var root in _configuration.AuthorizedRoots) _folders.Items.Add(root);
            foreach (var app in _configuration.AppList) AddAppItem(app);
            foreach (var command in _configuration.CommandList) AddCommandItem(command);
            _startButton.Enabled = true;
            SetStatus($"الجهاز مربوط ({_configuration.DeviceId}). اختر «تشغيل استقبال المهام» للبدء.");
        }
        catch (Exception exception)
        {
            SetStatus($"تعذر فتح إعدادات الوكيل المحمية لهذا المستخدم: {exception.Message}");
        }
    }

    private void AddFolder()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "اختر مجلدًا محليًا تسمح لوكيل Smart.z باستخدامه",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        var root = NormalizeRoot(dialog.SelectedPath);
        if (_folders.Items.Cast<string>().Any(existing =>
            string.Equals(NormalizeRoot(existing), root, StringComparison.OrdinalIgnoreCase)))
        {
            SetStatus("هذا المجلد مضاف بالفعل.");
            return;
        }
        _folders.Items.Add(root);
        SaveConfigurationIfPaired();
    }

    private void AddApp()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "اختر البرنامج الذي تسمح للهاتف بفتحه",
            Filter = "البرامج (*.exe)|*.exe",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        var name = PromptText("اسم البرنامج", "الاسم الذي ستقوله للمساعد (مثل: الوورد، المتصفح):",
            Path.GetFileNameWithoutExtension(dialog.FileName));
        if (name is null) return;
        if (_appItems.Any(app => string.Equals(app.Name, name, StringComparison.OrdinalIgnoreCase)))
        {
            SetStatus("يوجد برنامج بهذا الاسم.");
            return;
        }
        AddAppItem(new AgentApp(name, Path.GetFullPath(dialog.FileName)));
        SaveConfigurationIfPaired();
    }

    private void AddCommand()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "اختر البرنامج أو السكربت الذي يشغّله هذا الأمر",
            Filter = "البرامج والسكربتات (*.exe;*.bat;*.cmd)|*.exe;*.bat;*.cmd|كل الملفات (*.*)|*.*",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        var name = PromptText("اسم الأمر", "الاسم الذي ستقوله للمساعد (مثل: نسخ احتياطي):",
            Path.GetFileNameWithoutExtension(dialog.FileName));
        if (name is null) return;
        if (_commandItems.Any(command => string.Equals(command.Name, name, StringComparison.OrdinalIgnoreCase)))
        {
            SetStatus("يوجد أمر بهذا الاسم.");
            return;
        }
        var arguments = PromptText("وسائط الأمر", "وسائط ثابتة تُمرَّر للأمر (اتركها فارغة إن لم توجد):", string.Empty, allowEmpty: true);
        if (arguments is null) return;
        AddCommandItem(new AgentCommand(name, Path.GetFullPath(dialog.FileName), arguments));
        SaveConfigurationIfPaired();
    }

    private void AddAppItem(AgentApp app)
    {
        _appItems.Add(app);
        _apps.Items.Add($"{app.Name} — {app.Path}");
    }

    private void AddCommandItem(AgentCommand command)
    {
        _commandItems.Add(command);
        _commands.Items.Add($"{command.Name} — {command.Path} {command.Arguments}".TrimEnd());
    }

    private void RemoveSelected<T>(ListBox list, List<T> items)
    {
        var index = list.SelectedIndex;
        if (index < 0 || index >= items.Count) return;
        items.RemoveAt(index);
        list.Items.RemoveAt(index);
        SaveConfigurationIfPaired();
    }

    private string? PromptText(string title, string prompt, string initial, bool allowEmpty = false)
    {
        using var form = new Form
        {
            Text = title,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterParent,
            MinimizeBox = false,
            MaximizeBox = false,
            ClientSize = new Size(420, 130),
            RightToLeft = RightToLeft.Yes,
            RightToLeftLayout = true,
        };
        var label = new Label { Text = prompt, AutoSize = true, Location = new Point(12, 12) };
        var input = new TextBox { Text = initial, Width = 396, Location = new Point(12, 40), MaxLength = allowEmpty ? 400 : 64 };
        var ok = new Button { Text = "حفظ", DialogResult = DialogResult.OK, Location = new Point(12, 84), AutoSize = true };
        var cancel = new Button { Text = "إلغاء", DialogResult = DialogResult.Cancel, Location = new Point(110, 84), AutoSize = true };
        form.Controls.AddRange([label, input, ok, cancel]);
        form.AcceptButton = ok;
        form.CancelButton = cancel;
        while (form.ShowDialog(this) == DialogResult.OK)
        {
            var value = input.Text.Trim();
            if (value.Any(char.IsControl)) continue;
            if (allowEmpty || value.Length is >= 1 and <= 64) return value;
        }
        return null;
    }

    private void RemoveFolder()
    {
        if (_folders.SelectedItem is not string selected) return;
        _folders.Items.Remove(selected);
        SaveConfigurationIfPaired();
    }

    private async Task PairAsync()
    {
        if (_pairButton.Enabled == false) return;
        if (_folders.Items.Count == 0)
        {
            SetStatus("اختر مجلدًا محليًا واحدًا على الأقل قبل الاقتران.");
            return;
        }

        if (!TryNormalizeOrigin(_origin.Text, out var origin, out var error))
        {
            SetStatus(error);
            return;
        }
        var cleanLabel = _label.Text.Trim();
        if (cleanLabel.Length is < 1 or > 64 || cleanLabel.Any(char.IsControl))
        {
            SetStatus("اسم الكمبيوتر يجب أن يكون من 1 إلى 64 حرفًا.");
            return;
        }

        _pairButton.Enabled = false;
        _qr.Image?.Dispose();
        _qr.Image = null;
        _configuration = null;
        string? sessionId = null;
        string? token = null;
        byte[]? privateKeyBytes = null;
        try
        {
            using var key = Key.Create(
                SignatureAlgorithm.Ed25519,
                new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
            privateKeyBytes = key.Export(KeyBlobFormat.RawPrivateKey);
            var publicRaw = key.PublicKey.Export(KeyBlobFormat.RawPublicKey);
            var publicDer = new byte[SpkiEd25519Prefix.Length + publicRaw.Length];
            SpkiEd25519Prefix.CopyTo(publicDer, 0);
            publicRaw.CopyTo(publicDer, SpkiEd25519Prefix.Length);
            CryptographicOperations.ZeroMemory(publicRaw);

            _http = CreateHttpClient(origin);
            SetStatus("جارٍ إنشاء جلسة اقتران قصيرة الصلاحية…");
            using var createResponse = await _http.PostAsJsonAsync(
                "/api/computer/pairing/sessions",
                new { publicKey = Base64Url(publicDer), deviceLabel = cleanLabel },
                JsonOptions);
            using var createJson = await ReadResponseAsync(createResponse);
            EnsureResponse(createResponse, createJson.RootElement);
            sessionId = createJson.RootElement.GetProperty("sessionId").GetString();
            token = createJson.RootElement.GetProperty("token").GetString();
            var expiry = createJson.RootElement.GetProperty("expiresAt").GetDateTimeOffset();
            if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(token))
            {
                throw new InvalidDataException("تعذر قراءة بيانات جلسة الاقتران.");
            }

            var qrPayload = JsonSerializer.Serialize(new
            {
                version = 1,
                origin,
                sessionId,
                token,
            }, JsonOptions);
            using (var generator = new QRCodeGenerator())
            using (var data = generator.CreateQrCode(qrPayload, QRCodeGenerator.ECCLevel.M))
            {
                var png = new PngByteQRCode(data).GetGraphic(8);
                using var stream = new MemoryStream(png);
                using var sourceImage = Image.FromStream(stream);
                _qr.Image = new Bitmap(sourceImage);
            }

            SetStatus("امسح رمز QR من هاتفك ووافق على الاقتران. تنتهي الجلسة خلال خمس دقائق.");
            while (DateTimeOffset.UtcNow < expiry && !_closing)
            {
                await Task.Delay(TimeSpan.FromSeconds(2));
                using var statusResponse = await _http.PostAsJsonAsync(
                    $"/api/computer/pairing/sessions/{sessionId}/status",
                    new { token },
                    JsonOptions);
                using var statusJson = await ReadResponseAsync(statusResponse);
                if (!statusResponse.IsSuccessStatusCode)
                {
                    if (statusResponse.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
                    {
                        throw new InvalidOperationException("انتهت جلسة الاقتران أو أُلغيت.");
                    }
                    continue;
                }

                var state = statusJson.RootElement.GetProperty("status").GetString();
                if (state == "rejected") throw new InvalidOperationException("رفض المستخدم طلب الاقتران.");
                if (state == "expired") throw new InvalidOperationException("انتهت صلاحية رمز الاقتران.");
                if (state != "approved") continue;

                var challenge = statusJson.RootElement.GetProperty("challenge").GetString();
                if (string.IsNullOrWhiteSpace(challenge)) throw new InvalidDataException("لم يصل تحدي إثبات المفتاح.");
                var proofMessage = Encoding.UTF8.GetBytes($"{PairingProofPrefix}{sessionId}:{challenge}");
                using var signingKey = Key.Import(
                    SignatureAlgorithm.Ed25519,
                    privateKeyBytes,
                    KeyBlobFormat.RawPrivateKey,
                    new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
                var signature = SignatureAlgorithm.Ed25519.Sign(signingKey, proofMessage);
                using var completeResponse = await _http.PostAsJsonAsync(
                    $"/api/computer/pairing/sessions/{sessionId}/complete",
                    new { token, signature = Base64Url(signature) },
                    JsonOptions);
                using var completeJson = await ReadResponseAsync(completeResponse);
                EnsureResponse(completeResponse, completeJson.RootElement);
                var deviceId = completeJson.RootElement.GetProperty("deviceId").GetString();
                if (string.IsNullOrWhiteSpace(deviceId)) throw new InvalidDataException("لم يرجع الخادم معرّف الجهاز.");

                var roots = _folders.Items.Cast<string>().Select(NormalizeRoot).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
                _configuration = new AgentConfiguration(
                    origin, deviceId, cleanLabel, Base64Url(privateKeyBytes), roots,
                    [.. _appItems], [.. _commandItems]);
                _configuration.Save();
                _origin.Text = origin;
                _startButton.Enabled = true;
                _qr.Image?.Dispose();
                _qr.Image = null;
                SetStatus("اكتمل الاقتران وحُفظ المفتاح مشفرًا لمستخدم Windows الحالي. شغّل استقبال المهام عند الحاجة.");
                return;
            }

            throw new InvalidOperationException("انتهت صلاحية جلسة الاقتران.");
        }
        catch (Exception exception)
        {
            SetStatus($"لم يكتمل الاقتران: {exception.Message}");
            if (sessionId is not null && token is not null && _http is not null)
            {
                try
                {
                    using var ignored = await _http.PostAsJsonAsync(
                        $"/api/computer/pairing/sessions/{sessionId}/cancel",
                        new { token },
                        JsonOptions);
                }
                catch (HttpRequestException) { }
            }
        }
        finally
        {
            if (privateKeyBytes is not null) CryptographicOperations.ZeroMemory(privateKeyBytes);
            _pairButton.Enabled = !_closing;
        }
    }

    private void StartWorker()
    {
        if (_configuration is null) return;
        if (_workerCancellation is not null)
        {
            SetStatus("استقبال المهام يعمل بالفعل.");
            return;
        }

        _http?.Dispose();
        _http = CreateHttpClient(_configuration.Origin);
        _workerCancellation = new CancellationTokenSource();
        _startButton.Enabled = false;
        _stopButton.Enabled = true;
        SetStatus("يستقبل الوكيل المهام المعتمدة. أوقفه في أي وقت من هذا التطبيق.");
        _workerTask = WorkerLoopAsync(_workerCancellation.Token);
    }

    private async Task StopWorkerAsync()
    {
        var cancellation = _workerCancellation;
        if (cancellation is null) return;
        _stopButton.Enabled = false;
        cancellation.Cancel();
        try
        {
            if (_workerTask is not null) await _workerTask;
        }
        finally
        {
            cancellation.Dispose();
            if (ReferenceEquals(_workerCancellation, cancellation)) _workerCancellation = null;
            _workerTask = null;
            _startButton.Enabled = _configuration is not null;
            SetStatus("توقف استقبال المهام.");
        }
    }

    private async Task WorkerLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var deviceId = _configuration!.DeviceId;
                var claimPath = $"/api/computer/devices/{deviceId}/tasks/claim";
                using var response = await SendSignedAsync(HttpMethod.Post, claimPath, new { });
                using var json = await ReadResponseAsync(response);
                if (response.StatusCode == HttpStatusCode.Forbidden)
                {
                    SetStatus("أُلغي ربط الجهاز أو لم يعد نشطًا. أوقف الوكيل وأعد الاقتران بعد التحقق من الحساب.");
                    _workerCancellation?.Cancel();
                    return;
                }
                EnsureResponse(response, json.RootElement);
                var task = json.RootElement.GetProperty("task");
                if (task.ValueKind == JsonValueKind.Null)
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
                    continue;
                }

                var taskId = task.GetProperty("id").GetString()!;
                SetStatus($"بدأ تنفيذ مهمة معتمدة ({task.GetProperty("task_type").GetString()}).");
                using var executionCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                var watcher = WatchForCancellationAsync(taskId, executionCancellation, cancellationToken);
                try
                {
                    var result = await Task.Run(
                        () => ExecuteFileTask(task, executionCancellation.Token),
                        executionCancellation.Token);
                    executionCancellation.Token.ThrowIfCancellationRequested();
                    var resultPath = $"/api/computer/devices/{deviceId}/tasks/{taskId}/result";
                    using var report = await SendSignedAsync(
                        HttpMethod.Post,
                        resultPath,
                        new { status = "succeeded", result });
                    using var reportJson = await ReadResponseAsync(report);
                    EnsureResponse(report, reportJson.RootElement);
                    SetStatus("اكتملت المهمة وأُعيدت نتيجتها إلى الهاتف.");
                }
                catch (OperationCanceledException) when (executionCancellation.IsCancellationRequested)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        try
                        {
                            var resultPath = $"/api/computer/devices/{_configuration!.DeviceId}/tasks/{taskId}/result";
                            using var report = await SendSignedAsync(
                                HttpMethod.Post,
                                resultPath,
                                new
                                {
                                    status = "failed",
                                    result = new { errorCode = "AGENT_STOPPED" },
                                });
                            using var reportJson = await ReadResponseAsync(report);
                        }
                        catch (HttpRequestException) { }
                    }
                    SetStatus("أُلغيت المهمة من الهاتف أو أوقف المستخدم الوكيل.");
                }
                catch (Exception exception)
                {
                    var resultPath = $"/api/computer/devices/{deviceId}/tasks/{taskId}/result";
                    try
                    {
                        using var report = await SendSignedAsync(
                            HttpMethod.Post,
                            resultPath,
                            new
                            {
                                status = "failed",
                                result = FailureResult(exception),
                            });
                        using var reportJson = await ReadResponseAsync(report);
                        EnsureResponse(report, reportJson.RootElement);
                        SetStatus($"فشلت المهمة برمز {ClassifyError(exception)}؛ لم تُرفع تفاصيل محلية أو مسارات مطلقة.");
                    }
                    catch (Exception reportError)
                    {
                        SetStatus($"تعذر إرسال نتيجة المهمة ({ClassifyError(reportError)}).");
                    }
                }
                finally
                {
                    executionCancellation.Cancel();
                    await watcher;
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                SetStatus($"تعذر الاتصال أو استقبال مهمة ({ClassifyError(exception)}). ستتم إعادة المحاولة.");
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(4), cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
            }
        }

        if (!_closing && IsHandleCreated)
        {
            BeginInvoke(() =>
            {
                _startButton.Enabled = _configuration is not null;
                _stopButton.Enabled = false;
                _workerCancellation?.Dispose();
                _workerCancellation = null;
            });
        }
    }

    private async Task WatchForCancellationAsync(
        string taskId,
        CancellationTokenSource executionCancellation,
        CancellationToken workerCancellation)
    {
        var failures = 0;
        while (!executionCancellation.IsCancellationRequested && !workerCancellation.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(2), executionCancellation.Token);
                var path = $"/api/computer/devices/{_configuration!.DeviceId}/tasks/{taskId}";
                using var response = await SendSignedAsync(HttpMethod.Get, path);
                using var json = await ReadResponseAsync(response);
                EnsureResponse(response, json.RootElement);
                var status = json.RootElement.GetProperty("status").GetString();
                if (status != "running")
                {
                    executionCancellation.Cancel();
                    return;
                }
                failures = 0;
            }
            catch (OperationCanceledException) when (executionCancellation.IsCancellationRequested || workerCancellation.IsCancellationRequested)
            {
                return;
            }
            catch (Exception)
            {
                failures++;
                if (failures >= 3)
                {
                    executionCancellation.Cancel();
                    return;
                }
            }
        }
    }

    private object ExecuteFileTask(JsonElement task, CancellationToken cancellationToken)
    {
        var type = task.GetProperty("task_type").GetString();
        var payload = task.GetProperty("payload");
        switch (type)
        {
            case "open_url":
                return LimitResult(LocalActions.OpenUrl(RequiredString(payload, "url")));
            case "open_app":
                return LimitResult(LocalActions.OpenApp(_configuration!.AppList, RequiredString(payload, "appName")));
            case "run_command":
                return LimitResult(LocalActions.RunCommand(_configuration!.CommandList, RequiredString(payload, "commandName"), cancellationToken));
        }

        var requestedRoot = payload.GetProperty("authorizedRoot").GetString();
        if (string.IsNullOrWhiteSpace(requestedRoot)) throw new UnauthorizedAccessException();
        var root = NormalizeRoot(requestedRoot);
        if (!_configuration!.AuthorizedRoots.Any(allowed =>
            string.Equals(NormalizeRoot(allowed), root, StringComparison.OrdinalIgnoreCase)))
        {
            throw new UnauthorizedAccessException();
        }
        EnsureNoReparsePoint(root);

        return type switch
        {
            "list_files" => ListDirectory(root, OptionalString(payload, "path"), OptionalInt(payload, "maxEntries", 100), cancellationToken),
            "search_files" => SearchNames(root, OptionalString(payload, "path"), RequiredString(payload, "query"), OptionalInt(payload, "maxResults", 50), cancellationToken),
            "file_metadata" => GetMetadata(root, RequiredString(payload, "path"), cancellationToken),
            "transfer_file" => TransferFile(root, RequiredString(payload, "sourcePath"), RequiredString(payload, "destinationPath"), cancellationToken),
            "open_file" => LimitResult(LocalActions.OpenDocument(ResolveSafePath(root, RequiredString(payload, "path")), RequiredString(payload, "path"))),
            _ => throw new InvalidDataException(),
        };
    }

    private static object ListDirectory(string root, string? relativePath, int limit, CancellationToken cancellationToken)
    {
        var directory = ResolveSafePath(root, relativePath ?? string.Empty);
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException();
        var items = new List<object>();
        foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (items.Count >= Math.Clamp(limit, 1, 100)) break;
            EnsureNoReparsePoint(entry);
            var attributes = File.GetAttributes(entry);
            var info = (attributes & FileAttributes.Directory) != 0
                ? (FileSystemInfo)new DirectoryInfo(entry)
                : new FileInfo(entry);
            items.Add(new
            {
                name = Path.GetFileName(entry),
                path = Path.GetRelativePath(root, entry),
                kind = (attributes & FileAttributes.Directory) != 0 ? "directory" : "file",
                sizeBytes = info is FileInfo file ? file.Length : (long?)null,
                lastWriteUtc = info.LastWriteTimeUtc,
            });
        }
        return LimitResult(new { items });
    }

    private static object SearchNames(
        string root,
        string? relativePath,
        string query,
        int limit,
        CancellationToken cancellationToken)
    {
        if (query.Length is < 1 or > 256) throw new InvalidDataException();
        var start = ResolveSafePath(root, relativePath ?? string.Empty);
        if (!Directory.Exists(start)) throw new DirectoryNotFoundException();
        var pending = new Stack<string>();
        var results = new List<string>();
        pending.Push(start);

        while (pending.Count > 0 && results.Count < Math.Clamp(limit, 1, 100))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var directory = pending.Pop();
            EnsureNoReparsePoint(directory);
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                cancellationToken.ThrowIfCancellationRequested();
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                if (Path.GetFileName(entry).Contains(query, StringComparison.OrdinalIgnoreCase))
                {
                    results.Add(Path.GetRelativePath(root, entry));
                    if (results.Count >= Math.Clamp(limit, 1, 100)) break;
                }
                if ((attributes & FileAttributes.Directory) != 0) pending.Push(entry);
            }
        }
        return LimitResult(new { items = results });
    }

    private static object GetMetadata(string root, string relativePath, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var path = ResolveSafePath(root, relativePath);
        EnsureNoReparsePoint(path);
        if (File.Exists(path))
        {
            var file = new FileInfo(path);
            return LimitResult(new { path = Path.GetRelativePath(root, path), kind = "file", sizeBytes = file.Length, lastWriteUtc = file.LastWriteTimeUtc });
        }
        if (Directory.Exists(path))
        {
            var directory = new DirectoryInfo(path);
            return LimitResult(new { path = Path.GetRelativePath(root, path), kind = "directory", lastWriteUtc = directory.LastWriteTimeUtc });
        }
        throw new FileNotFoundException();
    }

    private static object TransferFile(
        string root,
        string sourceRelativePath,
        string destinationRelativePath,
        CancellationToken cancellationToken)
    {
        var source = ResolveSafePath(root, sourceRelativePath);
        var destination = ResolveSafePath(root, destinationRelativePath);
        EnsureNoReparsePoint(source);
        EnsureNoReparsePoint(Path.GetDirectoryName(destination)!);
        var sourceInfo = new FileInfo(source);
        if (!sourceInfo.Exists || sourceInfo.Length > 64 * 1024 * 1024) throw new InvalidDataException();
        if (File.Exists(destination) || Directory.Exists(destination)) throw new IOException();

        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read, buffer.Length, FileOptions.SequentialScan);
            using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, buffer.Length, FileOptions.WriteThrough);
            int read;
            long copied = 0;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
                copied += read;
                if (copied > 64 * 1024 * 1024) throw new InvalidDataException();
                output.Write(buffer, 0, read);
            }
            output.Flush(flushToDisk: true);
            return LimitResult(new { source = sourceRelativePath, destination = destinationRelativePath, sizeBytes = copied });
        }
        catch
        {
            if (File.Exists(destination)) File.Delete(destination);
            throw;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(buffer);
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private async Task<HttpResponseMessage> SendSignedAsync(HttpMethod method, string path, object? body = null)
    {
        var configuration = _configuration ?? throw new InvalidOperationException();
        var bodyBytes = body is null ? Array.Empty<byte>() : JsonSerializer.SerializeToUtf8Bytes(body, JsonOptions);
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        var nonce = Base64Url(RandomNumberGenerator.GetBytes(24));
        var message = ComputerRequestMessage(method, path, timestamp, nonce, bodyBytes);
        var privateBytes = FromBase64Url(configuration.PrivateKey);
        try
        {
            using var key = Key.Import(
                SignatureAlgorithm.Ed25519,
                privateBytes,
                KeyBlobFormat.RawPrivateKey,
                new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
            var signature = Base64Url(SignatureAlgorithm.Ed25519.Sign(key, message));
            var request = new HttpRequestMessage(method, path);
            if (body is not null) request.Content = new ByteArrayContent(bodyBytes);
            request.Headers.Add("X-Smartz-Timestamp", timestamp);
            request.Headers.Add("X-Smartz-Nonce", nonce);
            request.Headers.Add("X-Smartz-Signature", signature);
            return await _http!.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(privateBytes);
            CryptographicOperations.ZeroMemory(bodyBytes);
            CryptographicOperations.ZeroMemory(message);
        }
    }

    private static byte[] ComputerRequestMessage(HttpMethod method, string path, string timestamp, string nonce, byte[] body)
    {
        var bodyHash = Convert.ToHexStringLower(SHA256.HashData(body));
        return Encoding.UTF8.GetBytes(string.Join(
            '\n',
            "smartz-computer-request:v1",
            method.Method.ToUpperInvariant(),
            path,
            timestamp,
            nonce,
            bodyHash));
    }

    private static string ResolveSafePath(string root, string relativePath)
    {
        if (relativePath.Length > 512 ||
            Path.IsPathRooted(relativePath) ||
            relativePath.Contains(':') ||
            relativePath.Contains('\0') ||
            (relativePath.Length > 0 && relativePath.Split(['\\', '/'], StringSplitOptions.None).Any(segment =>
                segment is "" or "." or ".." ||
                segment.EndsWith(' ') ||
                segment.EndsWith('.') ||
                segment.Any(char.IsControl) ||
                segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)))
        {
            throw new UnauthorizedAccessException();
        }

        var fullRoot = NormalizeRoot(root);
        var fullPath = Path.GetFullPath(Path.Combine(fullRoot, relativePath.Replace('/', Path.DirectorySeparatorChar)));
        var prefix = fullRoot.EndsWith(Path.DirectorySeparatorChar)
            ? fullRoot
            : fullRoot + Path.DirectorySeparatorChar;
        if (!string.Equals(fullPath, fullRoot, StringComparison.OrdinalIgnoreCase) &&
            !fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException();
        }
        EnsureNoReparsePoint(fullPath);
        return fullPath;
    }

    private static void EnsureNoReparsePoint(string path)
    {
        var fullPath = Path.GetFullPath(path);
        var root = Path.GetPathRoot(fullPath) ?? throw new UnauthorizedAccessException();
        var current = root;
        foreach (var component in fullPath[root.Length..].Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            if (!File.Exists(current) && !Directory.Exists(current)) continue;
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
            {
                throw new UnauthorizedAccessException();
            }
        }
    }

    private static object LimitResult<T>(T result)
    {
        var json = JsonSerializer.Serialize(result, JsonOptions);
        if (Encoding.UTF8.GetByteCount(json) > 7000) throw new InvalidDataException();
        return result!;
    }

    private static string? OptionalString(JsonElement payload, string name) =>
        payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string RequiredString(JsonElement payload, string name) =>
        OptionalString(payload, name) is { Length: > 0 } value ? value : throw new InvalidDataException();

    private static int OptionalInt(JsonElement payload, string name, int fallback) =>
        payload.TryGetProperty(name, out var value) && value.TryGetInt32(out var parsed)
            ? Math.Clamp(parsed, 1, 100)
            : fallback;

    private static string NormalizeRoot(string path)
    {
        var fullPath = Path.GetFullPath(path);
        return Path.TrimEndingDirectorySeparator(fullPath);
    }

    private static bool TryNormalizeOrigin(string value, out string origin, out string error)
    {
        if (Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) &&
            uri.UserInfo.Length == 0 &&
            uri.Query.Length == 0 &&
            uri.Fragment.Length == 0 &&
            uri.AbsolutePath == "/" &&
            (uri.Scheme == Uri.UriSchemeHttps ||
                (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)))
        {
            origin = uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
            error = string.Empty;
            return true;
        }
        origin = string.Empty;
        error = "أدخل عنوان HTTPS موثوقًا لـSmart.z (يسمح بـHTTP على localhost للاختبار المحلي فقط).";
        return false;
    }

    private static HttpClient CreateHttpClient(string origin) =>
        new(new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
        })
        {
            BaseAddress = new Uri(origin + "/"),
            Timeout = TimeSpan.FromSeconds(15),
        };

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string value)
    {
        var base64 = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(base64.PadRight(base64.Length + ((4 - base64.Length % 4) % 4), '='));
    }

    private static async Task<JsonDocument> ReadResponseAsync(HttpResponseMessage response)
    {
        var bytes = await response.Content.ReadAsByteArrayAsync();
        if (bytes.Length > 16 * 1024) throw new InvalidDataException("استجابة الخادم أكبر من المسموح.");
        return JsonDocument.Parse(bytes);
    }

    private static void EnsureResponse(HttpResponseMessage response, JsonElement json)
    {
        if (response.IsSuccessStatusCode) return;
        var message = json.TryGetProperty("message", out var property)
            ? property.GetString()
            : null;
        throw new HttpRequestException(message ?? $"رفض الخادم الطلب ({(int)response.StatusCode}).", null, response.StatusCode);
    }

    private static string ClassifyError(Exception exception) => exception switch
    {
        LocalActionNotFoundException notFound => notFound.Kind == "app" ? "APP_NOT_IN_LOCAL_LIST" : "COMMAND_NOT_IN_LOCAL_LIST",
        TimeoutException => "COMMAND_TIMED_OUT",
        UnauthorizedAccessException => "SCOPE_NOT_AUTHORIZED",
        FileNotFoundException => "FILE_NOT_FOUND",
        DirectoryNotFoundException => "DIRECTORY_NOT_FOUND",
        OperationCanceledException => "CANCELLED",
        HttpRequestException => "NETWORK_ERROR",
        InvalidDataException => "INVALID_TASK_DATA",
        _ => "LOCAL_FILE_OPERATION_FAILED",
    };

    /// <summary>Error code only; for an unknown app/command also the local names, so the phone can suggest one.</summary>
    private static object FailureResult(Exception exception) => exception is LocalActionNotFoundException notFound
        ? new { errorCode = ClassifyError(exception), available = notFound.Available }
        : new { errorCode = ClassifyError(exception) };

    private void SaveConfigurationIfPaired()
    {
        if (_configuration is null) return;
        _configuration = _configuration with
        {
            AuthorizedRoots = _folders.Items.Cast<string>().Select(NormalizeRoot).ToArray(),
            Apps = [.. _appItems],
            Commands = [.. _commandItems],
        };
        _configuration.Save();
    }

    private void SetStatus(string text)
    {
        if (_closing || IsDisposed || !IsHandleCreated) return;
        if (InvokeRequired)
        {
            BeginInvoke(() => SetStatus(text));
            return;
        }
        _status.Text = text;
    }

    private async void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_closing) return;
        _closing = true;
        if (_workerCancellation is not null)
        {
            e.Cancel = true;
            _workerCancellation.Cancel();
            if (_workerTask is not null) await _workerTask;
            BeginInvoke(Close);
            return;
        }
        _http?.Dispose();
        _qr.Image?.Dispose();
    }
}
