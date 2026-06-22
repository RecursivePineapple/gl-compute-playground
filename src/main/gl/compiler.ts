import GL from 'node-native-gl';

const LOG_BUF = 4096;

// Compiles a GLSL compute shader and returns any driver error messages.
// Returns { errors: [] } on success.
export function compileShader(source: string): { errors: string[] } {
  const result = compileProgram(source);
  if ('error' in result) return { errors: [result.error] };
  GL.deleteProgram(result.program);
  return { errors: [] };
}

// Compiles source as a compute shader and links it into a program.
// Returns { program } on success, { error } on failure.
export function compileProgram(source: string): { program: number } | { error: string } {
  const shader = GL.createShader(GL.COMPUTE_SHADER);
  GL.shaderSource(shader, source);
  GL.compileShader(shader);

  if (GL.getShaderiv(shader, GL.COMPILE_STATUS)[0] === 0) {
    const log = GL.getShaderInfoLog(shader, LOG_BUF)[1] as string;
    GL.deleteShader(shader);
    return { error: log.trim() };
  }

  const program = GL.createProgram();
  GL.attachShader(program, shader);
  GL.linkProgram(program);
  GL.deleteShader(shader);

  if (GL.getProgramiv(program, GL.LINK_STATUS)[0] === 0) {
    const log = GL.getProgramInfoLog(program, LOG_BUF)[1] as string;
    GL.deleteProgram(program);
    return { error: log.trim() };
  }

  return { program };
}
