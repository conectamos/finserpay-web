package com.finserpay.clientes;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.URLUtil;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import com.google.firebase.messaging.FirebaseMessaging;

public class MainActivity extends Activity {
    private static final String CLIENT_URL = "https://finserpay.com/clientes";
    private static final int DOWNLOAD_PERMISSION_REQUEST = 1002;
    private WebView webView;
    private ProgressBar progressBar;
    private TextView offlineMessage;
    private String pendingDownloadUrl;
    private String pendingDownloadUserAgent;
    private String pendingDownloadContentDisposition;
    private String pendingDownloadMimeType;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF3F7F6);

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(3)
        );
        progressParams.gravity = Gravity.TOP;
        progressBar.setMax(100);
        progressBar.setLayoutParams(progressParams);

        offlineMessage = new TextView(this);
        offlineMessage.setText("No se pudo abrir FINSER PAY. Revisa tu conexion e intenta de nuevo.");
        offlineMessage.setTextColor(0xFF111827);
        offlineMessage.setTextSize(16);
        offlineMessage.setGravity(Gravity.CENTER);
        offlineMessage.setPadding(dp(28), dp(28), dp(28), dp(28));
        offlineMessage.setVisibility(View.GONE);
        offlineMessage.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        root.addView(webView);
        root.addView(offlineMessage);
        root.addView(progressBar);
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.addJavascriptInterface(new FinserAndroidBridge(), "FinserPayAndroid");
        webView.setWebViewClient(new FinserWebViewClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                requestDownload(url, userAgent, contentDisposition, mimeType)
        );
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                progressBar.setProgress(progress);
                progressBar.setVisibility(progress >= 100 ? View.GONE : View.VISIBLE);
            }
        });

        setupPushNotifications();
        webView.loadUrl(resolveLaunchUrl(getIntent()));
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            String[] permissions,
            int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode != DOWNLOAD_PERMISSION_REQUEST) {
            return;
        }

        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            enqueueDownload(
                    pendingDownloadUrl,
                    pendingDownloadUserAgent,
                    pendingDownloadContentDisposition,
                    pendingDownloadMimeType
            );
        } else {
            Toast.makeText(
                    this,
                    "Permite guardar archivos para descargar el paz y salvo.",
                    Toast.LENGTH_LONG
            ).show();
        }

        clearPendingDownload();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        loadUrlFromIntent(intent);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    private int dp(int value) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(value * density);
    }

    private void loadUrlFromIntent(Intent intent) {
        if (webView == null) {
            return;
        }

        webView.loadUrl(resolveLaunchUrl(intent));
    }

    private String resolveLaunchUrl(Intent intent) {
        Uri dataUri = intent == null ? null : intent.getData();

        if (isAllowedClientUri(dataUri)) {
            return dataUri.toString();
        }

        String urlExtra = intent == null ? "" : intent.getStringExtra("url");
        Uri urlUri = urlExtra == null || urlExtra.trim().isEmpty()
                ? null
                : Uri.parse(urlExtra.trim());

        if (isAllowedClientUri(urlUri)) {
            return urlUri.toString();
        }

        String documento = firstNonEmpty(
                intent == null ? null : intent.getStringExtra("documento"),
                FinserPushRegistry.getSavedDocument(this)
        ).replaceAll("\\D", "");
        String credito = intent == null
                ? ""
                : firstNonEmpty(
                        intent.getStringExtra("credito"),
                        intent.getStringExtra("creditoId")
                );
        String panel = intent == null ? "" : firstNonEmpty(intent.getStringExtra("panel"), "");

        Uri.Builder builder = Uri.parse(CLIENT_URL).buildUpon();
        if (documento.length() >= 5) {
            builder.appendQueryParameter("documento", documento);
        }
        if (!credito.trim().isEmpty()) {
            builder.appendQueryParameter("credito", credito.trim());
        }
        if (!panel.trim().isEmpty()) {
            builder.appendQueryParameter("panel", panel.trim());
        }

        return builder.build().toString();
    }

    private boolean isAllowedClientUri(Uri uri) {
        if (uri == null) {
            return false;
        }

        String host = uri.getHost();
        String path = uri.getPath();

        return "https".equalsIgnoreCase(uri.getScheme())
                && host != null
                && (host.equals("finserpay.com") || host.endsWith(".finserpay.com"))
                && path != null
                && path.startsWith("/clientes");
    }

    private String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }

        return "";
    }

    private void setupPushNotifications() {
        createNotificationChannel();
        requestNotificationPermission();

        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    FinserPushRegistry.saveTokenAndSync(this, task.getResult());
                }
            });
        } catch (Exception ignored) {
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
                getString(R.string.fcm_channel_id),
                getString(R.string.fcm_channel_name),
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription(getString(R.string.fcm_channel_description));
        manager.createNotificationChannel(channel);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }

        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }

        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
    }

    private void requestDownload(
            String url,
            String userAgent,
            String contentDisposition,
            String mimeType
    ) {
        if (url == null || url.trim().isEmpty()) {
            Toast.makeText(this, "No se pudo validar la descarga.", Toast.LENGTH_LONG).show();
            return;
        }

        Uri uri = Uri.parse(url);
        String host = uri.getHost();

        if (!"https".equalsIgnoreCase(uri.getScheme())
                || host == null
                || !(host.equals("finserpay.com") || host.endsWith(".finserpay.com"))) {
            Toast.makeText(this, "No se pudo validar la descarga.", Toast.LENGTH_LONG).show();
            return;
        }

        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            pendingDownloadUrl = url;
            pendingDownloadUserAgent = userAgent;
            pendingDownloadContentDisposition = contentDisposition;
            pendingDownloadMimeType = mimeType;
            requestPermissions(
                    new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                    DOWNLOAD_PERMISSION_REQUEST
            );
            return;
        }

        enqueueDownload(url, userAgent, contentDisposition, mimeType);
    }

    private void enqueueDownload(
            String url,
            String userAgent,
            String contentDisposition,
            String mimeType
    ) {
        if (url == null || url.trim().isEmpty()) {
            return;
        }

        try {
            String resolvedMimeType = mimeType == null || mimeType.trim().isEmpty()
                    ? "application/pdf"
                    : mimeType;
            String fileName = buildUniqueFileName(URLUtil.guessFileName(
                    url,
                    contentDisposition,
                    resolvedMimeType
            ));
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(resolvedMimeType);
            request.setTitle(fileName);
            request.setDescription("Descargando documento FINSER PAY");
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
            );
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null && !cookies.trim().isEmpty()) {
                request.addRequestHeader("Cookie", cookies);
            }
            if (userAgent != null && !userAgent.trim().isEmpty()) {
                request.addRequestHeader("User-Agent", userAgent);
            }

            DownloadManager manager =
                    (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                throw new IllegalStateException("DownloadManager no disponible");
            }

            manager.enqueue(request);
            Toast.makeText(
                    this,
                    "El paz y salvo se esta guardando en Descargas.",
                    Toast.LENGTH_LONG
            ).show();
        } catch (Exception error) {
            Toast.makeText(
                    this,
                    "No se pudo iniciar la descarga. Intenta de nuevo.",
                    Toast.LENGTH_LONG
            ).show();
        }
    }

    private void clearPendingDownload() {
        pendingDownloadUrl = null;
        pendingDownloadUserAgent = null;
        pendingDownloadContentDisposition = null;
        pendingDownloadMimeType = null;
    }

    private String buildUniqueFileName(String fileName) {
        int extensionIndex = fileName.lastIndexOf('.');
        String suffix = "-" + System.currentTimeMillis();

        if (extensionIndex <= 0 || extensionIndex == fileName.length() - 1) {
            return fileName + suffix;
        }

        return fileName.substring(0, extensionIndex)
                + suffix
                + fileName.substring(extensionIndex);
    }

    private boolean isAllowedPazYSalvoDownload(String url) {
        if (url == null || url.trim().isEmpty()) {
            return false;
        }

        try {
            Uri uri = Uri.parse(url.trim());
            if (!uri.isHierarchical()) {
                return false;
            }

            String host = uri.getHost();
            String path = uri.getPath();
            String documento = uri.getQueryParameter("documento");

            return "https".equalsIgnoreCase(uri.getScheme())
                    && host != null
                    && (host.equals("finserpay.com") || host.endsWith(".finserpay.com"))
                    && path != null
                    && path.matches("^/api/clientes/creditos/\\d+/paz-y-salvo$")
                    && documento != null
                    && documento.matches("^\\d{5,20}$");
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private class FinserAndroidBridge {
        @JavascriptInterface
        public void downloadDocument(String url, String suggestedFileName) {
            if (!isAllowedPazYSalvoDownload(url)) {
                runOnUiThread(() -> Toast.makeText(
                        MainActivity.this,
                        "No se pudo validar la descarga.",
                        Toast.LENGTH_LONG
                ).show());
                return;
            }

            String safeFileName = suggestedFileName == null
                    ? "paz-y-salvo.pdf"
                    : suggestedFileName.replaceAll("[^A-Za-z0-9._-]", "-");
            if (safeFileName.isEmpty()) {
                safeFileName = "paz-y-salvo.pdf";
            }
            if (!safeFileName.toLowerCase().endsWith(".pdf")) {
                safeFileName += ".pdf";
            }
            if (safeFileName.length() > 120) {
                safeFileName = safeFileName.substring(0, 116) + ".pdf";
            }
            String contentDisposition =
                    "attachment; filename=\"" + safeFileName + "\"";

            runOnUiThread(() -> requestDownload(
                    url,
                    webView.getSettings().getUserAgentString(),
                    contentDisposition,
                    "application/pdf"
            ));
        }

        @JavascriptInterface
        public void registerClient(String documento) {
            FinserPushRegistry.saveDocumentAndSync(MainActivity.this, documento);
        }
    }

    private class FinserWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            offlineMessage.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                webView.setVisibility(View.GONE);
                offlineMessage.setVisibility(View.VISIBLE);
            }
            super.onReceivedError(view, request, error);
        }

        private boolean handleUrl(Uri uri) {
            String host = uri.getHost();
            if (host == null) {
                return false;
            }

            if (host.equals("finserpay.com") || host.endsWith(".finserpay.com")) {
                return false;
            }

            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
            return true;
        }
    }
}
