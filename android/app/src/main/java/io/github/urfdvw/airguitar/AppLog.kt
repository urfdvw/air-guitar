package io.github.urfdvw.airguitar

import android.content.Context
import android.os.SystemClock
import android.util.Log
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Event log for field testing. Every line goes to logcat (tag `AirGuitar`)
 * and to a file per app session under
 * `Android/data/<package>/files/logs/`, so it survives a crash and can be
 * pulled with adb or shared from the app.
 *
 * Lines are events (hits, touches, chord changes, settings), never raw sensor
 * samples; those go to trace CSVs recorded on demand.
 */
object AppLog {
    const val TAG = "AirGuitar"
    private const val KEEP_SESSIONS = 10

    private val stamp = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private var writer: BufferedWriter? = null
    lateinit var dir: File
        private set
    lateinit var sessionFile: File
        private set
    /** Every file this session wrote (log and traces), for export. */
    val sessionFiles = mutableListOf<File>()

    @Synchronized
    fun init(context: Context) {
        if (writer != null) return
        dir = File(context.getExternalFilesDir(null) ?: context.filesDir, "logs").apply { mkdirs() }
        // Keep the folder from growing without end.
        dir.listFiles()
            ?.sortedByDescending { it.lastModified() }
            ?.drop(KEEP_SESSIONS * 4)
            ?.forEach { it.delete() }
        val name = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        sessionFile = File(dir, "session-$name.log")
        sessionFiles += sessionFile
        writer = BufferedWriter(FileWriter(sessionFile, true))
        i("log started ${sessionFile.absolutePath}")
    }

    fun newFile(prefix: String, extension: String): File {
        val name = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val file = File(dir, "$prefix-$name.$extension")
        synchronized(this) { sessionFiles += file }
        return file
    }

    @Synchronized
    fun i(message: String) {
        // Wall clock for humans, elapsed ms to line up with trace CSVs.
        val line = "${stamp.format(Date())} [${SystemClock.elapsedRealtime()}] $message"
        Log.i(TAG, message)
        try {
            writer?.apply {
                write(line)
                newLine()
                flush()
            }
        } catch (error: Exception) {
            Log.w(TAG, "log write failed", error)
        }
    }

    @Synchronized
    fun flush() {
        try {
            writer?.flush()
        } catch (_: Exception) {
        }
    }
}
