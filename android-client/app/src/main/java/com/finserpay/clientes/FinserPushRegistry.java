package com.finserpay.clientes;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class FinserPushRegistry {
    private static final String ENDPOINT = "https://finserpay.com/api/clientes/fcm-token";
    private static final String PREFS = "finserpay_push";
    private static final String KEY_DOCUMENT = "documento";
    private static final String KEY_TOKEN = "fcm_token";

    private FinserPushRegistry() {
    }

    public static void saveDocumentAndSync(Context context, String documento) {
        String normalized = normalizeDocument(documento);
        if (normalized.length() < 5) {
            return;
        }

        context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_DOCUMENT, normalized)
                .apply();
        syncIfReady(context);
    }

    public static void saveTokenAndSync(Context context, String token) {
        if (token == null || token.trim().length() < 20) {
            return;
        }

        context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_TOKEN, token.trim())
                .apply();
        syncIfReady(context);
    }

    private static void syncIfReady(Context context) {
        Context appContext = context.getApplicationContext();
        SharedPreferences prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String token = prefs.getString(KEY_TOKEN, "");
        String documento = prefs.getString(KEY_DOCUMENT, "");

        if (token == null || token.length() < 20 || documento == null || documento.length() < 5) {
            return;
        }

        new Thread(() -> sendRegistration(appContext, token, documento)).start();
    }

    private static void sendRegistration(Context context, String token, String documento) {
        HttpURLConnection connection = null;

        try {
            JSONObject payload = new JSONObject();
            payload.put("appVersion", getAppVersion(context));
            payload.put("documento", documento);
            payload.put("platform", "ANDROID");
            payload.put("token", token);

            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            URL url = new URL(ENDPOINT);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);
            connection.setDoOutput(true);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");

            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 400
                    ? connection.getErrorStream()
                    : connection.getInputStream();
            drain(stream);
        } catch (Exception ignored) {
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static void drain(InputStream stream) {
        if (stream == null) {
            return;
        }

        try (InputStream input = stream) {
            byte[] buffer = new byte[512];
            while (input.read(buffer) != -1) {
                // Drain the response so Android can close the connection cleanly.
            }
        } catch (Exception ignored) {
        }
    }

    private static String getAppVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0);
            return info.versionName == null ? "unknown" : info.versionName;
        } catch (Exception ignored) {
            return "unknown";
        }
    }

    private static String normalizeDocument(String value) {
        if (value == null) {
            return "";
        }

        return value.replaceAll("\\D", "");
    }
}
