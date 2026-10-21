package com.smartz.assistant;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;

@CapacitorPlugin(name = "DocumentExport")
public class DocumentExportPlugin extends Plugin {
    @PluginMethod
    public void shareFile(PluginCall call) {
        String fileName = call.getString("fileName", "مستند.docx");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String data = call.getString("data", "");
        if (data.isEmpty()) { call.reject("الملف فارغ."); return; }
        getActivity().runOnUiThread(() -> {
            try {
                File sharedDirectory = new File(getContext().getCacheDir(), "shared-documents");
                if (!sharedDirectory.exists() && !sharedDirectory.mkdirs()) {
                    throw new IllegalStateException("تعذر تجهيز الملف للمشاركة.");
                }
                File sharedFile = new File(sharedDirectory, new File(fileName).getName());
                try (FileOutputStream output = new FileOutputStream(sharedFile)) {
                    output.write(Base64.decode(data, Base64.DEFAULT));
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", sharedFile);
                Intent share = new Intent(Intent.ACTION_SEND)
                    .setType(mimeType)
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .setClipData(ClipData.newRawUri("document", uri))
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(Intent.createChooser(share, "مشاركة ملف"));
                call.resolve();
            } catch (Exception error) {
                call.reject("تعذر فتح قائمة المشاركة.", error);
            }
        });
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
