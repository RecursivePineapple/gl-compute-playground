import GLFW from 'glfw-n-api';
import GL from 'node-native-gl';

// Initialises a hidden GLFW window and makes its OpenGL 4.3 core context current.
// Must be called once before any GL operations (shader compilation, pipeline execution).
export function initGLContext(): void {
  if (!GLFW.glfwInit()) throw new Error('glfwInit failed');

  GLFW.glfwWindowHint(GLFW.GLFW_VISIBLE, GLFW.GLFW_FALSE);
  GLFW.glfwWindowHint(GLFW.GLFW_CLIENT_API, GLFW.GLFW_OPENGL_API);
  GLFW.glfwWindowHint(GLFW.GLFW_CONTEXT_VERSION_MAJOR, 4);
  GLFW.glfwWindowHint(GLFW.GLFW_CONTEXT_VERSION_MINOR, 3);
  GLFW.glfwWindowHint(GLFW.GLFW_OPENGL_PROFILE, GLFW.GLFW_OPENGL_CORE_PROFILE);

  const win = GLFW.glfwCreateWindow(1, 1, 'GL Compute', null, null);
  if (!win) throw new Error('glfwCreateWindow failed');

  GLFW.glfwMakeContextCurrent(win);

  const glewStatus = GL.init();
  if (glewStatus !== 0) throw new Error(`glewInit failed: ${glewStatus}`);
}
