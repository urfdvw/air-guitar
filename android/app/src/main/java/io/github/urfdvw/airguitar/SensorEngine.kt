package io.github.urfdvw.airguitar

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.util.Locale
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.sqrt

/**
 * The accelerometer at its fastest rate, on its own thread.
 *
 * Gravity and slow hand movement are removed with a one-pole high-pass, which
 * leaves the short bumps a finger tap or an edge scratch makes. Its magnitude
 * (m/s²) is the one number everything works from:
 *
 *  - a ring of the last second of samples answers "how hard was that tap" for
 *    the force button, which asks just after the touch arrives;
 *  - with scratch detection on, a rising edge over the threshold starts a hit,
 *    measured for a few ms and then reported through [onHit].
 */
class SensorEngine(context: Context, private val onHit: (Hit) -> Unit, private val onTraceDone: (File?) -> Unit) :
    SensorEventListener {

    data class Hit(val strength: Float, val hx: Float, val hy: Float, val hz: Float, val sensorTimeNs: Long)

    data class Config(
        val scratch: Boolean = false,
        val threshold: Float = 1.5f,
        val refractoryMs: Float = 90f,
        val peakWindowMs: Float = 4f,
        val touchSuppressMs: Float = 80f,
        val highPassHz: Float = 2f,
    )

    @Volatile
    var config = Config()

    private val manager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val sensor: Sensor? = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

    private val thread = HandlerThread("accelerometer", Process.THREAD_PRIORITY_URGENT_DISPLAY).apply { start() }
    private val handler = Handler(thread.looper)

    private var wanted = false
    private var resumed = false
    private var registered = false

    // -- high-pass state (sensor thread only) --
    private var gx = 0f
    private var gy = 0f
    private var gz = 0f
    private var primed = false
    private var lastSampleNs = 0L

    // -- ring of recent samples (guarded by `ring`) --
    private val size = 2048
    private val ringT = LongArray(size)
    private val ringX = FloatArray(size)
    private val ringY = FloatArray(size)
    private val ringZ = FloatArray(size)
    private val ringM = FloatArray(size)
    private var ringHead = 0
    private var ringCount = 0
    private val ring = Any()

    // -- meter (guarded by `ring`) --
    private var meterPeak = 0f
    @Volatile
    var rateHz = 0f
        private set

    // -- scratch detection (sensor thread only) --
    private var above = false
    private var armedUntilNs = 0L
    private var lastFireNs = 0L
    private var peak = 0f
    private var peakX = 0f
    private var peakY = 0f
    private var peakZ = 0f
    private var peakT = 0L

    @Volatile
    private var lastTouchNs = 0L

    // -- trace recording (sensor thread only) --
    private var trace: BufferedWriter? = null
    private var traceFile: File? = null
    private var traceEndNs = 0L
    private var traceStartNs = 0L
    private var pendingTraceEvent: String? = null

    fun describe(): String {
        val s = sensor ?: return "no accelerometer"
        return "${s.name} (${s.vendor}) minDelay=${s.minDelay}us maxRange=${s.maximumRange} resolution=${s.resolution}"
    }

    fun setWanted(want: Boolean) = handler.post {
        wanted = want
        update()
    }

    fun resume() = handler.post {
        resumed = true
        update()
    }

    fun pause() = handler.post {
        resumed = false
        update()
    }

    fun shutdown() {
        handler.post {
            resumed = false
            update()
            closeTrace(false)
            thread.quitSafely()
        }
    }

    private fun update() {
        val run = resumed && (wanted || trace != null)
        if (run == registered) return
        val s = sensor
        if (run && s != null) {
            // 0 µs: as fast as the hardware goes.
            registered = manager.registerListener(this, s, 0, handler)
            primed = false
            rateHz = 0f
            AppLog.i("sensor on: registered=$registered ${describe()}")
        } else if (!run && registered) {
            manager.unregisterListener(this)
            registered = false
            AppLog.i("sensor off")
        }
    }

    fun noteTouch() {
        lastTouchNs = SystemClock.elapsedRealtimeNanos()
        handler.post { if (trace != null) pendingTraceEvent = "touch" }
    }

    /** Strongest sample of the last [ms], as JSON for the page. */
    fun peakSince(ms: Int): String {
        val now = SystemClock.elapsedRealtimeNanos()
        val since = now - ms * 1_000_000L
        var best = -1f
        var bx = 0f
        var by = 0f
        var bz = 0f
        var count = 0
        var newestAgeMs = -1.0
        synchronized(ring) {
            var i = ringHead
            for (n in 0 until ringCount) {
                i = (i - 1 + size) % size
                if (ringT[i] < since) break
                if (n == 0) newestAgeMs = (now - ringT[i]) / 1e6
                count++
                if (ringM[i] > best) {
                    best = ringM[i]
                    bx = ringX[i]
                    by = ringY[i]
                    bz = ringZ[i]
                }
            }
        }
        if (count == 0) {
            AppLog.i("peakSince($ms): no samples (sensor registered=$registered)")
            return """{"peak":null,"samples":0,"rate":$rateHz}"""
        }
        return """{"peak":$best,"hx":$bx,"hy":$by,"hz":$bz,"samples":$count,"rate":$rateHz,"newestAgeMs":$newestAgeMs}"""
    }

    fun meter(): String {
        val p: Float
        synchronized(ring) {
            p = meterPeak
            meterPeak = 0f
        }
        return """{"rate":$rateHz,"peak":$p,"registered":$registered}"""
    }

    fun recordTrace(seconds: Int) = handler.post {
        closeTrace(false)
        try {
            val file = AppLog.newFile("trace", "csv")
            traceFile = file
            trace = BufferedWriter(FileWriter(file)).apply {
                write("t_ms,ax,ay,az,hx,hy,hz,mag,event")
                newLine()
            }
            traceStartNs = SystemClock.elapsedRealtimeNanos()
            traceEndNs = traceStartNs + seconds * 1_000_000_000L
            AppLog.i("trace start ${seconds}s -> ${file.name}")
            update()
        } catch (error: Exception) {
            AppLog.i("trace start failed: $error")
            trace = null
            onTraceDone(null)
        }
    }

    private fun closeTrace(notify: Boolean) {
        val writer = trace ?: return
        trace = null
        try {
            writer.close()
        } catch (_: Exception) {
        }
        AppLog.i("trace saved ${traceFile?.name}")
        if (notify) onTraceDone(traceFile)
        update()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        AppLog.i("sensor accuracy $accuracy")
    }

    override fun onSensorChanged(event: SensorEvent) {
        val t = event.timestamp
        val ax = event.values[0]
        val ay = event.values[1]
        val az = event.values[2]

        if (!primed) {
            gx = ax
            gy = ay
            gz = az
            primed = true
            lastSampleNs = t
            return
        }
        val dt = (t - lastSampleNs).coerceAtLeast(1L) / 1e9f
        lastSampleNs = t
        val instantRate = 1f / dt
        rateHz = if (rateHz == 0f) instantRate else rateHz + (instantRate - rateHz) * 0.02f

        val alpha = 1f - exp(-dt * 2f * Math.PI.toFloat() * config.highPassHz)
        gx += (ax - gx) * alpha
        gy += (ay - gy) * alpha
        gz += (az - gz) * alpha
        val hx = ax - gx
        val hy = ay - gy
        val hz = az - gz
        val mag = sqrt(hx * hx + hy * hy + hz * hz)

        synchronized(ring) {
            ringT[ringHead] = t
            ringX[ringHead] = hx
            ringY[ringHead] = hy
            ringZ[ringHead] = hz
            ringM[ringHead] = mag
            ringHead = (ringHead + 1) % size
            if (ringCount < size) ringCount++
            meterPeak = max(meterPeak, mag)
        }

        val cfg = config
        var traceEvent = pendingTraceEvent
        pendingTraceEvent = null
        if (cfg.scratch) traceEvent = detect(t, hx, hy, hz, mag, cfg) ?: traceEvent

        trace?.let { writer ->
            try {
                writer.write(
                    String.format(
                        Locale.US,
                        "%.3f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%s",
                        (t - traceStartNs) / 1e6, ax, ay, az, hx, hy, hz, mag, traceEvent ?: "",
                    ),
                )
                writer.newLine()
            } catch (_: Exception) {
            }
            if (t >= traceEndNs) closeTrace(true)
        }
    }

    /** Scratch detection. Returns a note for the trace when something happened. */
    private fun detect(t: Long, hx: Float, hy: Float, hz: Float, mag: Float, cfg: Config): String? {
        if (armedUntilNs != 0L) {
            if (mag > peak) {
                peak = mag
                peakX = hx
                peakY = hy
                peakZ = hz
                peakT = t
            }
            if (t >= armedUntilNs) {
                armedUntilNs = 0L
                return fire(t)
            }
            return null
        }

        val crossing = mag > cfg.threshold
        val rising = crossing && !above
        above = mag > cfg.threshold * 0.6f // a little hysteresis before re-arming
        if (!rising) return null

        val sinceFireMs = (t - lastFireNs) / 1e6f
        val sinceTouchMs = (SystemClock.elapsedRealtimeNanos() - lastTouchNs) / 1e6f
        when {
            sinceFireMs < cfg.refractoryMs -> {
                AppLog.i(String.format(Locale.US, "cross %.2f ignored: %.0fms since last hit", mag, sinceFireMs))
                return "cross-refractory"
            }
            sinceTouchMs < cfg.touchSuppressMs -> {
                AppLog.i(String.format(Locale.US, "cross %.2f ignored: %.0fms since screen touch", mag, sinceTouchMs))
                return "cross-touch"
            }
        }

        peak = mag
        peakX = hx
        peakY = hy
        peakZ = hz
        peakT = t
        if (cfg.peakWindowMs <= 0f) return fire(t)
        armedUntilNs = t + (cfg.peakWindowMs * 1e6f).toLong()
        return "arm"
    }

    private fun fire(t: Long): String {
        lastFireNs = t
        onHit(Hit(peak, peakX, peakY, peakZ, peakT))
        return String.format(Locale.US, "hit:%.2f", peak)
    }
}
