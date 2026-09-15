/*
 * Minimal Java example for checking an Axiom license from your Minecraft/Fabric client.
 * Adapt package names, JSON handling, UI, and shutdown behavior to your actual mod.
 *
 * IMPORTANT: a website cannot enforce expiration by itself. Your mod must call the
 * server and disable protected functionality whenever valid != true.
 */

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;

public final class AxiomLicenseClient {
    private final HttpClient http = HttpClient.newHttpClient();
    private final String apiBase;

    public AxiomLicenseClient(String apiBase) {
        this.apiBase = apiBase.replaceAll("/$", "");
    }

    public boolean check(String licenseKey, String clientId) {
        try {
            String body = "{\"key\":\"" + jsonEscape(licenseKey) + "\",\"clientId\":\"" + jsonEscape(clientId) + "\"}";
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(apiBase + "/api/license/check"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();

            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            return response.statusCode() == 200 && response.body().contains("\"valid\":true");
        } catch (Exception e) {
            return false; // fail closed if the license server cannot be reached
        }
    }

    private static String jsonEscape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
