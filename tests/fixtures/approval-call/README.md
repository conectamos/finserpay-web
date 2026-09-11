These three fixtures contain only a generated 440 Hz tone, lasting 0.5 seconds.
There are no voices, client data or third-party recordings. The WAV uses mono
16-bit PCM at 16 kHz. MP3 and M4A were encoded from that WAV at 32 kbit/s using
FFmpeg (`libmp3lame` and `aac`, respectively), with `-map_metadata -1`.

The tone was generated with samples `round(sin(i * 2 * PI * 440 / 16000) * 2000)`.
It is intentionally synthetic and may be freely reused as a test fixture.
FFmpeg is only a local fixture-generation tool; it is not an app dependency.
