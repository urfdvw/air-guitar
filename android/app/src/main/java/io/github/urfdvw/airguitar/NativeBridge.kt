package io.github.urfdvw.airguitar

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.util.Locale

/**
 * What the page sees as `window.AirGuitarAndroid`. Methods run on WebView's
 * bridge thread; anything touching views goes through the UI thread.
 *
 * Events back to the page are plain JSON objects passed to
 * `window.__airGuitarNativeEvent`, which js/native.js installs.
 */
class NativeBridge(private val activity: Activity, private val webView: WebView) {

    val sensors = SensorEngine(
        activity,
        onHit = { hit -> onHit(hit) },
        onTraceDone = { file ->
            emit(JSONObject().put("type", "trace").put("ok", file != null).put("file", file?.name ?: ""))
        },
    )

    private fun onHit(hit: SensorEngine.Hit) {
        val ageMs = (android.os.SystemClock.elapsedRealtimeNanos() - hit.sensorTimeNs) / 1e6
        AppLog.i(
            String.format(
                Locale.US,
                "native hit strength=%.2f h=(%.2f,%.2f,%.2f) age=%.1fms",
                hit.strength, hit.hx, hit.hy, hit.hz, ageMs,
            ),
        )
        emit(
            JSONObject()
                .put("type", "hit")
                .put("strength", hit.strength.toDouble())
                .put("hx", hit.hx.toDouble())
                .put("hy", hit.hy.toDouble())
                .put("hz", hit.hz.toDouble())
                .put("ageMs", ageMs),
        )
    }

    private fun emit(event: JSONObject) {
        val script = "window.__airGuitarNativeEvent && window.__airGuitarNativeEvent($event)"
        webView.post { webView.evaluateJavascript(script, null) }
    }

    @JavascriptInterface
    fun configure(json: String) {
        try {
            val o = JSONObject(json)
            val next = SensorEngine.Config(
                scratch = o.optBoolean("scratch", false),
                threshold = o.optDouble("threshold", 1.5).toFloat(),
                refractoryMs = o.optDouble("refractoryMs", 90.0).toFloat(),
                peakWindowMs = o.optDouble("peakWindowMs", 15.0).toFloat(),
                touchSuppressMs = o.optDouble("touchSuppressMs", 80.0).toFloat(),
            )
            if (next != sensors.config) {
                sensors.config = next
                AppLog.i("configure $next")
            }
        } catch (error: Exception) {
            AppLog.i("configure failed: $error for $json")
        }
    }

    @JavascriptInterface
    fun setSensorActive(active: Boolean) {
        sensors.setWanted(active)
    }

    @JavascriptInterface
    fun noteTouch() {
        sensors.noteTouch()
    }

    @JavascriptInterface
    fun peakSince(ms: Int): String = sensors.peakSince(ms)

    @JavascriptInterface
    fun meter(): String = sensors.meter()

    @JavascriptInterface
    fun log(message: String) {
        AppLog.i("js: $message")
    }

    @JavascriptInterface
    fun recordTrace(seconds: Int) {
        sensors.recordTrace(seconds.coerceIn(1, 120))
    }

    @JavascriptInterface
    fun deviceInfo(): String = JSONObject()
        .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
        .put("android", Build.VERSION.RELEASE)
        .put("sdk", Build.VERSION.SDK_INT)
        .put("sensor", sensors.describe())
        .put("app", BuildConfigInfo.version(activity))
        .put("logDir", AppLog.dir.absolutePath)
        .toString()

    /** Shares this session's log and traces through the system share sheet. */
    @JavascriptInterface
    fun exportLogs() {
        AppLog.i("export requested")
        AppLog.flush()
        activity.runOnUiThread {
            val files = synchronized(AppLog) { AppLog.sessionFiles.filter(File::exists) }
            if (files.isEmpty()) return@runOnUiThread
            val authority = "${activity.packageName}.logs"
            val uris = ArrayList<Uri>(files.map { FileProvider.getUriForFile(activity, authority, it) })
            val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                type = "text/plain"
                putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                putExtra(Intent.EXTRA_SUBJECT, "Air guitar log ${files.first().name}")
                clipData = ClipData.newRawUri("log", uris.first()).also { clip ->
                    uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
                }
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(Intent.createChooser(intent, "Export log"))
        }
    }
}

private object BuildConfigInfo {
    fun version(activity: Activity): String = try {
        val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
        "${info.versionName}"
    } catch (_: Exception) {
        "?"
    }
}
