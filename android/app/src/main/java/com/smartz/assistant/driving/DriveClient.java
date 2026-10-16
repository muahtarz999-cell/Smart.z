package com.smartz.assistant.driving;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/** The two server calls of driving mode: one turn, and executing a WhatsApp send. */
final class DriveClient {
    static final class Result {
        final int status;
        final JSONObject body;

        Result(int status, JSONObject body) {
            this.status = status;
            this.body = body;
        }

        boolean ok() {
            return status >= 200 && status < 300;
        }
    }

    private DriveClient() { }

    /** POST /api/drive/turn — multipart: audio (WAV) + context (JSON). */
    static Result turn(String baseUrl, String token, byte[] wav, String contextJson) throws IOException {
        String boundary = "----smartz" + System.nanoTime();
        HttpURLConnection connection = open(baseUrl + "/api/drive/turn", token, 75_000);
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try (OutputStream out = connection.getOutputStream()) {
            write(out, "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"audio\"; filename=\"audio.wav\"\r\n"
                + "Content-Type: audio/wav\r\n\r\n");
            out.write(wav);
            write(out, "\r\n--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"context\"\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n\r\n");
            write(out, contextJson);
            write(out, "\r\n--" + boundary + "--\r\n");
        }
        return read(connection);
    }

    /** POST a JSON body (used for /api/whatsapp/cluster/send). */
    static Result postJson(String baseUrl, String path, String token, JSONObject body) throws IOException {
        HttpURLConnection connection = open(baseUrl + path, token, 45_000);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        try (OutputStream out = connection.getOutputStream()) {
            write(out, body.toString());
        }
        return read(connection);
    }

    /** Audio from POST /api/speech, or null when no cloud voice answered. */
    static byte[][] speech(String baseUrl, String token, String text, JSONObject voice) {
        try {
            JSONObject body = new JSONObject();
            body.put("text", text);
            if (voice != null) {
                String provider = voice.optString("provider", "auto");
                if (!provider.isEmpty() && !"auto".equals(provider)) body.put("provider", provider);
                JSONObject voices = voice.optJSONObject("voices");
                if (voices != null) body.put("voices", voices);
            }
            HttpURLConnection connection = open(baseUrl + "/api/speech", token, 20_000);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream out = connection.getOutputStream()) {
                write(out, body.toString());
            }
            try {
                if (connection.getResponseCode() != 200) return null;
                String type = connection.getContentType();
                try (InputStream in = connection.getInputStream(); ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                    byte[] chunk = new byte[16_384];
                    int n;
                    while ((n = in.read(chunk)) != -1) buffer.write(chunk, 0, n);
                    return new byte[][] { buffer.toByteArray(), (type == null ? "" : type).getBytes(StandardCharsets.UTF_8) };
                }
            } finally {
                connection.disconnect();
            }
        } catch (IOException | JSONException error) {
            return null;
        }
    }

    private static HttpURLConnection open(String url, String token, int readTimeoutMs) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setConnectTimeout(12_000);
        connection.setReadTimeout(readTimeoutMs);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json");
        return connection;
    }

    private static Result read(HttpURLConnection connection) throws IOException {
        try {
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = "";
            if (stream != null) {
                try (InputStream in = stream; ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                    byte[] chunk = new byte[16_384];
                    int n;
                    while ((n = in.read(chunk)) != -1) buffer.write(chunk, 0, n);
                    text = buffer.toString(StandardCharsets.UTF_8.name());
                }
            }
            JSONObject body;
            try {
                body = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            } catch (JSONException error) {
                body = new JSONObject();
            }
            return new Result(status, body);
        } finally {
            connection.disconnect();
        }
    }

    private static void write(OutputStream out, String text) throws IOException {
        out.write(text.getBytes(StandardCharsets.UTF_8));
    }
}
