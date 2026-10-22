package com.fairshare.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "IdentityProtection")
public class IdentityProtectionPlugin extends Plugin {
    private static final String PREFIX = "com.fairshare.identity.";

    private KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    private String alias(JSONObject envelope) throws Exception {
        return PREFIX + UUID.fromString(envelope.getString("id")).toString();
    }

    @PluginMethod
    public void protect(PluginCall call) {
        String peerId = call.getString("peerId");
        String privateKey = call.getString("privateKey");
        if (peerId == null || privateKey == null || privateKey.isEmpty()) {
            call.reject("Missing identity key or peer ID.");
            return;
        }
        String id = UUID.randomUUID().toString();
        try {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(
                PREFIX + id, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build());
            SecretKey wrappingKey = generator.generateKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey);
            cipher.updateAAD(peerId.getBytes(StandardCharsets.UTF_8));
            byte[] encrypted = cipher.doFinal(privateKey.getBytes(StandardCharsets.UTF_8));
            JSONObject envelope = new JSONObject();
            envelope.put("id", id);
            envelope.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
            envelope.put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP));
            JSObject response = new JSObject();
            response.put("value", envelope.toString());
            call.resolve(response);
        } catch (Exception e) {
            call.reject("Could not protect the identity with Android Keystore.", e);
        }
    }

    @PluginMethod
    public void retrieve(PluginCall call) {
        try {
            String peerId = call.getString("peerId");
            JSONObject envelope = new JSONObject(call.getString("value", ""));
            SecretKey wrappingKey = (SecretKey) keyStore().getKey(alias(envelope), null);
            if (wrappingKey == null) {
                call.reject("The identity's Android Keystore key is missing. Restore an identity backup.");
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            byte[] iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP);
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey, new GCMParameterSpec(128, iv));
            cipher.updateAAD(peerId.getBytes(StandardCharsets.UTF_8));
            byte[] decrypted = cipher.doFinal(Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP));
            JSObject response = new JSObject();
            response.put("privateKey", new String(decrypted, StandardCharsets.UTF_8));
            call.resolve(response);
        } catch (Exception e) {
            call.reject("Could not retrieve the identity from Android Keystore.", e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            JSONObject envelope = new JSONObject(call.getString("value", ""));
            keyStore().deleteEntry(alias(envelope));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not remove the identity's Android Keystore key.", e);
        }
    }
}
