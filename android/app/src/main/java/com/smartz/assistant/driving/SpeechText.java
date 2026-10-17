package com.smartz.assistant.driving;

import java.util.ArrayList;
import java.util.List;

/**
 * Splits a reply into short pieces for /api/speech, at sentence ends where
 * possible (same idea as lib/text-chunks.js). Each piece stays under the
 * shortest cloud voice limit, so every provider can voice it.
 */
final class SpeechText {
    static final int MAX_PIECE = 180;

    private SpeechText() { }

    static List<String> pieces(String text, int max) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        String clean = text.replaceAll("\\s+", " ").trim();
        if (clean.isEmpty()) return out;

        // Sentences: up to and including . ! ? ؟ ، ؛ or a line end.
        List<String> sentences = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        for (int i = 0; i < clean.length(); i++) {
            char c = clean.charAt(i);
            current.append(c);
            if (c == '.' || c == '!' || c == '?' || c == '؟' || c == '،' || c == '؛') {
                sentences.add(current.toString().trim());
                current.setLength(0);
            }
        }
        if (current.toString().trim().length() > 0) sentences.add(current.toString().trim());

        StringBuilder piece = new StringBuilder();
        for (String sentence : sentences) {
            if (sentence.isEmpty()) continue;
            if (sentence.length() > max) {
                flush(piece, out);
                for (String word : sentence.split(" ")) {
                    if (piece.length() + word.length() + 1 > max) flush(piece, out);
                    if (piece.length() > 0) piece.append(' ');
                    piece.append(word.length() > max ? word.substring(0, max) : word);
                }
                continue;
            }
            if (piece.length() + sentence.length() + 1 > max) flush(piece, out);
            if (piece.length() > 0) piece.append(' ');
            piece.append(sentence);
        }
        flush(piece, out);
        return out;
    }

    private static void flush(StringBuilder piece, List<String> out) {
        String value = piece.toString().trim();
        if (!value.isEmpty()) out.add(value);
        piece.setLength(0);
    }
}
