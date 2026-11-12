package io.github.urfdvw.airguitar

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * The web app in a full-screen WebView, served from the APK's assets under a
 * real https origin (so localStorage, WebRTC and module scripts behave as on
 * the web), with [NativeBridge] attached for the accelerometer and the log.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var bridge: NativeBridge
    private var pendingPermission: PermissionRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLog.init(this)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // chrome://inspect works on debug builds, which is all CI makes.
        WebView.setWebContentsDebuggingEnabled(true)
        webView = WebView(this)
        setContentView(webView)
        goFullScreen()

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }
        webView.setBackgroundColor(0xFF131110.toInt())
        webView.isHapticFeedbackEnabled = false

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                AppLog.i("console ${message.messageLevel()}: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handlePermission(request) }
            }
        }

        bridge = NativeBridge(this, webView)
        webView.addJavascriptInterface(bridge, "AirGuitarAndroid")
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    /** Only the fretboard's QR scanner asks, for the camera. */
    private fun handlePermission(request: PermissionRequest) {
        val wantsCamera = PermissionRequest.RESOURCE_VIDEO_CAPTURE in request.resources
        if (!wantsCamera) {
            request.deny()
            return
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            pendingPermission?.deny()
            pendingPermission = request
            requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_REQUEST)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode != CAMERA_REQUEST) return
        val request = pendingPermission ?: return
        pendingPermission = null
        if (results.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            request.deny()
        }
    }

    /** Status and navigation bars cost strum travel; swipe from an edge to see them. */
    private fun goFullScreen() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            // Bars are hidden, but a camera cutout is still there: keep the page
            // out from under it rather than rely on the WebView's safe-area insets.
            webView.setOnApplyWindowInsetsListener { view, insets ->
                val cutout = insets.getInsets(WindowInsets.Type.displayCutout())
                view.setPadding(cutout.left, cutout.top, cutout.right, cutout.bottom)
                insets
            }
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goFullScreen()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        bridge.sensors.resume()
        AppLog.i("resume")
    }

    override fun onPause() {
        bridge.sensors.pause()
        webView.onPause()
        AppLog.i("pause")
        AppLog.flush()
        super.onPause()
    }

    override fun onDestroy() {
        bridge.sensors.shutdown()
        webView.destroy()
        super.onDestroy()
    }

    @Deprecated("Back goes back inside the page when it can.")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    private companion object {
        const val CAMERA_REQUEST = 1
    }
}
