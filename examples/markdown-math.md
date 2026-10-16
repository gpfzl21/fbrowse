# Markdown 수식 예제

문장 안에서는 $E=mc^2$ 또는 \(a_i + b_i\)를 사용할 수 있습니다.

## 별도 줄의 수식

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

\[
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
\]

## 여러 줄 정렬

\begin{align*}
f(x) &= x^2 + 2x + 1 \\
     &= (x+1)^2
\end{align*}

## math 코드 블록

```math
A = \begin{pmatrix}
1 & 2 \\
3 & 4
\end{pmatrix}
```

일반 코드는 `$x$`나 `\(x\)`처럼 작성해도 그대로 표시됩니다.

```js
const price = "$10";
```
