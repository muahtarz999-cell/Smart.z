package com.smartz.assistant;

import android.content.ContentValues;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.util.Base64;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

@CapacitorPlugin(name = "DocumentExport")
public class DocumentExportPlugin extends Plugin {
    @PluginMethod
    public void saveWord(PluginCall call) {
        String fileName = call.getString("fileName", "مستند.docx");
        String data = call.getString("data", "");
        if (data.isEmpty()) { call.reject("ملف Word فارغ."); return; }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            android.net.Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("تعذر إنشاء ملف التنزيل.");
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri)) {
                if (output == null) throw new IllegalStateException("تعذر فتح ملف التنزيل.");
                output.write(bytes);
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("تعذر حفظ ملف Word في مجلد التنزيلات.", error);
        }
    }

    @PluginMethod
    public void printPdf(PluginCall call) {
        String title = call.getString("title", "مستند");
        String html = call.getString("html", "");
        if (html.isEmpty()) { call.reject("محتوى المستند فارغ."); return; }
        getActivity().runOnUiThread(() -> {
            try {
                WebView printView = new WebView(getContext());
                printView.setWebViewClient(new WebViewClient() {
                    @Override public void onPageFinished(WebView view, String url) {
                        PrintManager manager = (PrintManager) getContext().getSystemService(android.content.Context.PRINT_SERVICE);
                        manager.print(title, view.createPrintDocumentAdapter(title), new PrintAttributes.Builder()
                            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                            .build());
                        call.resolve();
                    }
                });
                printView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            } catch (Exception error) {
                call.reject("تعذر فتح شاشة حفظ PDF.", error);
            }
        });
    }
}
