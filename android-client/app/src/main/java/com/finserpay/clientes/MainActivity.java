package com.finserpay.clientes;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.google.firebase.messaging.FirebaseMessaging;

public class MainActivity extends Activity {
    private static final String CLIENT_URL = "https://finserpay.com/clientes";
    private WebView webView;
    private ProgressBar progressBar;
    private TextView offlineMessage;

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

    private class FinserAndroidBridge {
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
