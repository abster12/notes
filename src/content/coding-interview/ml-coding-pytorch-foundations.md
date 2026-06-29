---
title: "ML Coding - PyTorch Foundations"
category: "Coding Interview Prep"
tags: [pytorch, ml-coding, deep-learning, tensors, autograd, nn-module]
last_updated: "2026-06-21"
---

# ML Coding Interview Prep — Part 1: PyTorch Foundations

The most common ML coding interview questions ask you to implement core components from scratch: a transformer layer, an attention mechanism, a training loop, a loss function. You need to be able to do these in PyTorch (or NumPy for the truly from-scratch versions) without looking anything up. This doc covers the foundational PyTorch machinery you'll use in every ML coding interview.

The companion doc, *ML Coding - Transformer*, covers transformer-specific implementations. This one is about PyTorch itself.

---

## Summary & Interview Framing

The PyTorch fundamentals needed to implement neural network components from scratch — tensors, autograd, nn.Module, and training loops.

**How it's asked:** "Implement a custom layer, write a training loop, debug a gradient flow — ML coding interviews test whether you can build, not just call APIs."

---

## Tensors — The Foundation

Every PyTorch computation revolves around `torch.Tensor`, a multi-dimensional array similar to NumPy's `ndarray` but with GPU support and autograd integration. If you understand NumPy, you understand most of what tensors can do.

### Shape, dtype, device

Every tensor has three fundamental attributes you must always know:

```python
import torch

x = torch.randn(2, 3, 4)  # 2x3x4 random tensor
print(x.shape)   # torch.Size([2, 3, 4])
print(x.dtype)   # torch.float32 (default)
print(x.device)  # cpu (or cuda:0 if moved to GPU)
```

These three attributes are the first thing you check when debugging a shape mismatch or dtype error. In interviews, the interviewer will often give you a tensor and expect you to reason about its shape, dtype, and what operations preserve/change each.

```
┌─────────────────────────────────────────────────────────┐
│  torch.Tensor                                             │
│  ┌─────────────────────────────────────────────────┐    │
│  │  data:    raw bytes (contiguous or strided)      │    │
│  │  shape:   torch.Size([2, 3, 4])                   │    │
│  │  dtype:   torch.float32 / .int64 / .bool etc.    │    │
│  │  device:  cpu / cuda:0 / cuda:1 / mps             │    │
│  │  requires_grad: True/False                        │    │
│  │  grad_fn: <AddBackward0> (set after autograd ops) │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### Common constructors

```python
torch.zeros(2, 3)           # All zeros
torch.ones(2, 3)            # All ones
torch.empty(2, 3)           # Uninitialized (faster than zeros)
torch.full((2, 3), 7)       # All 7s
torch.eye(3)                # 3x3 identity
torch.arange(0, 10, 2)      # [0, 2, 4, 6, 8]
torch.linspace(0, 1, 5)     # [0, 0.25, 0.5, 0.75, 1.0]
torch.tensor([1, 2, 3])     # From Python list
torch.randn(2, 3)           # Normal(0, 1)
torch.randint(0, 10, (2, 3)) # Uniform [0, 10)
```

### Shape manipulation

Reshaping is the most error-prone operation in tensor code. The key is to always know what the new shape means.

```python
x = torch.randn(2, 3, 4)   # shape: (2, 3, 4)
x.view(6, 4)                # Reshape: total elements must match
x.view(2, 12)               # Same: 2*3*4 = 24 elements
x.reshape(2, 12)            # Same as view but allows non-contiguous
x.transpose(0, 1)           # Swap dims 0 and 1, shape: (3, 2, 4)
x.permute(2, 0, 1)          # Reorder to (4, 2, 3) — common in image processing
x.squeeze()                 # Remove all dims of size 1
x.unsqueeze(0)              # Add dim at position 0, shape: (1, 2, 3, 4)
x.flatten()                 # Collapse all dims into one
```

The interview question: "Given a tensor of shape `(B, T, C)`, reshape it to `(B, T*C)`." Answer: `x.view(B, T*C)` or `x.reshape(B, T*C)`. The trap is that the memory must be contiguous for `view`; if not, use `reshape` (which copies if needed) or `contiguous().view()`.

### Indexing and slicing

PyTorch indexing follows NumPy semantics. This is the source of countless bugs.

```python
x = torch.randn(3, 4, 5)    # (3, 4, 5)
x[0]                         # First batch: (4, 5)
x[:, 0, :]                   # All batches, first row, all cols: (3, 5)
x[..., :2]                   # Ellipsis: (3, 4, 2) — last dim sliced
x[x > 0]                     # Boolean mask, returns 1D tensor
x[[0, 2, 1]]                 # Fancy indexing: reorders first dim
```

The interview trap: `x[0]` removes a dimension, but `x[0:1]` keeps it as shape `(1, 4, 5)`. This matters when you're broadcasting with another tensor.

---

## Tensor Operations

### Element-wise ops

Element-wise operations preserve shape and apply independently to each element. They include `+`, `-`, `*`, `/`, `**`, `torch.add`, `torch.mul`, etc.

```python
x = torch.tensor([1.0, 2.0, 3.0])
y = torch.tensor([4.0, 5.0, 6.0])
x + y       # [5, 7, 9]
x * y       # [4, 10, 18] (element-wise, not dot product)
x ** 2      # [1, 4, 9]
torch.sin(x)  # [0.84, 0.91, 0.14]
```

All element-wise operations support **broadcasting** — smaller tensors are virtually expanded to match the larger shape, without copying data. This is convenient but a common source of bugs.

### Broadcasting rules

Broadcasting follows two rules:
1. If tensors have different ranks, prepend 1s to the shape of the lower-rank tensor
2. For each dim, sizes must either be equal or one of them must be 1

```python
# (3, 1) + (1, 4) → (3, 4)
a = torch.randn(3, 1)
b = torch.randn(1, 4)
c = a + b   # shape (3, 4), each (i, j) = a[i, 0] + b[0, j]

# Common pattern: per-row bias
x = torch.randn(32, 128)      # batch of 32 vectors of dim 128
bias = torch.randn(128)        # one bias vector
x + bias                      # bias is broadcast across batch dim: (32, 128)
```

The interview trap: `(B, T) + (T,)` works (bias broadcast over batch) but `(B, T) + (B,)` fails because the last dim doesn't match.

### Matrix multiplication

Three ways to do matrix multiplication in PyTorch. Know all three.

```python
# 1. torch.matmul / @ — the standard way
a = torch.randn(3, 4)
b = torch.randn(4, 5)
c = a @ b                    # shape (3, 5)
torch.matmul(a, b)           # same

# 2. torch.mm — for 2D tensors only
torch.mm(a, b)               # shape (3, 5), fails for batched input

# 3. torch.bmm — for batched 3D tensors
a_batch = torch.randn(8, 3, 4)
b_batch = torch.randn(8, 4, 5)
c_batch = torch.bmm(a_batch, b_batch)  # shape (8, 3, 5)
```

For higher-dim batched matmul, use `matmul` or `einsum`. Einsum is the most flexible and is the interview-preferred way to express complex tensor operations clearly.

### Einsum

Einsum is a way to express tensor operations as sums over labeled indices. Once you learn it, you'll use it everywhere.

```python
# Matrix multiply: 'ik,kj->ij'
A = torch.randn(3, 4)
B = torch.randn(4, 5)
C = torch.einsum('ik,kj->ij', A, B)

# Batched matrix multiply: 'bik,bkj->bij'
A = torch.randn(8, 3, 4)
B = torch.randn(8, 4, 5)
C = torch.einsum('bik,bkj->bij', A, B)

# Attention scores: 'bhid,bhjd->bhij'  (Q @ K^T)
B, H, I, J, D = 2, 8, 10, 10, 64
Q = torch.randn(B, H, I, D)
K = torch.randn(B, H, J, D)
scores = torch.einsum('bhid,bhjd->bhij', Q, K)  # (B, H, I, J)

# Sum over a dim: 'bij->bi' or 'bij->b' or 'bij->'
x = torch.randn(2, 3, 4)
torch.einsum('bij->bi', x)   # Sum over j: (2, 3)
torch.einsum('bij->b', x)    # Sum over ij: (2,)
torch.einsum('bij->', x)     # Sum all: scalar
```

The interview advantage: einsum makes complex operations self-documenting. If you can read the equation, you can write the einsum.

### Reductions

```python
x = torch.randn(3, 4, 5)

x.sum()                      # Scalar
x.sum(dim=0)                 # Sum over dim 0: (4, 5)
x.sum(dim=(0, 2))            # Sum over dims 0 and 2: (4,)
x.mean(dim=-1)                # Mean over last dim
x.max(dim=1)                 # Returns (values, indices)
x.argmax(dim=1)              # Indices only
x.softmax(dim=-1)            # Along last dim
x.log_softmax(dim=-1)
x.topk(3, dim=-1)             # Top-3 values and indices
```

The `dim` argument is what you reduce over. The output shape is the input shape with `dim` removed. `keepdim=True` keeps the reduced dim as size 1.

---

## Autograd and Backpropagation

Autograd is PyTorch's automatic differentiation engine. You write forward-pass code as usual, and PyTorch builds a computation graph on the fly. Calling `.backward()` on a scalar traverses the graph backward and computes gradients for every tensor that has `requires_grad=True`.

### Basic usage

```python
x = torch.tensor([2.0, 3.0], requires_grad=True)
y = x ** 2                    # y = [4, 9]
z = y.sum()                   # z = 13
z.backward()                  # Compute dz/dx for each x[i]

print(x.grad)                  # [4, 6] (because dz/dx_i = 2*x_i)
```

```
Forward pass:
x ──► x² ──► y ──► sum ──► z

Backward pass (z.backward()):
∂z/∂x = ∂z/∂y · ∂y/∂x = 1 · 2x = [4, 6]
```

### requires_grad and no_grad

```python
# Default: tensors don't track gradients
x = torch.randn(3, 4)         # requires_grad=False

# Enable gradient tracking
x = torch.randn(3, 4, requires_grad=True)
x.requires_grad                # True

# Context manager: disable for evaluation
with torch.no_grad():
    y = model(x)              # No grad tracking, less memory

# Equivalent: detach a tensor from the graph
y = model(x).detach()         # No grad tracking for y
```

The interview question: "Why do we use `torch.no_grad()` during evaluation?" Answer: It saves memory (no graph stored), speeds up computation, and prevents accidental gradient updates. For inference, you don't need gradients.

### The backward pass

`.backward()` works on scalar tensors by default. For non-scalar outputs, pass `gradient` argument (the upstream gradient, which is usually ones_like(output) for simple cases).

```python
x = torch.tensor([2.0, 3.0], requires_grad=True)
y = x ** 2                    # shape (2,)

# This works: y is a tensor, not scalar, so we need gradient argument
y.backward(gradient=torch.ones_like(y))
print(x.grad)                  # [4, 6]

# Common pattern: sum then backward (scalar output)
loss = y.sum()
loss.backward()                # No gradient argument needed
```

### Accumulating gradients

Gradients accumulate by default. If you don't zero them between batches, they sum up.

```python
# WRONG: gradients accumulate
for x, y in dataloader:
    pred = model(x)
    loss = criterion(pred, y)
    loss.backward()           # grad accumulates
    optimizer.step()          # update

# CORRECT: zero gradients each iteration
for x, y in dataloader:
    optimizer.zero_grad()      # Reset to 0
    pred = model(x)
    loss = criterion(pred, y)
    loss.backward()
    optimizer.step()
```

The interview classic: "Why do we need to zero gradients?" Because `.backward()` accumulates into `.grad` rather than overwriting. This is intentional (it enables gradient accumulation across batches) but is a footgun for beginners.

### Gradient checkpointing

A memory-saving technique: instead of storing all intermediate activations, recompute them during backward. Trades ~30% more compute for ~10x less activation memory.

```python
from torch.utils.checkpoint import checkpoint

class BigModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.layer1 = nn.Linear(1024, 1024)
        self.layer2 = nn.Linear(1024, 1024)
        # ... many more layers

    def forward(self, x):
        # Without checkpointing: all activations stored
        x = self.layer1(x)
        x = self.layer2(x)

        # With checkpointing: only layer inputs/outputs stored
        x = checkpoint(self.layer1, x, use_reentrant=False)
        x = checkpoint(self.layer2, x, use_reentrant=False)
        return x
```

This is essential for fitting large models in GPU memory. Modern training frameworks (HF Trainer, etc.) enable it by default for big models.

### Detaching from the graph

Sometimes you want to use a tensor's value in a new computation but don't want gradients to flow back through it. Use `.detach()`.

```python
x = torch.randn(3, requires_grad=True)
y = x.detach()                 # y is a new tensor with no grad tracking
# Now operations on y don't contribute to x's gradient
```

The classic use case: target networks in RL, EMA models, gradient accumulation with detached loss values.

---

## Building nn.Module Subclasses

Every model in PyTorch subclasses `nn.Module`. The class wraps the parameters and defines the forward pass.

### Basic structure

```python
import torch
import torch.nn as nn
import torch.nn.functional as F

class SimpleClassifier(nn.Module):
    def __init__(self, input_dim, hidden_dim, num_classes):
        super().__init__()
        self.fc1 = nn.Linear(input_dim, hidden_dim)
        self.fc2 = nn.Linear(hidden_dim, hidden_dim)
        self.fc3 = nn.Linear(hidden_dim, num_classes)
        self.dropout = nn.Dropout(0.1)

    def forward(self, x):
        x = F.relu(self.fc1(x))
        x = self.dropout(x)
        x = F.relu(self.fc2(x))
        x = self.dropout(x)
        x = self.fc3(x)        # No softmax — use CrossEntropyLoss
        return x

model = SimpleClassifier(784, 256, 10)
print(sum(p.numel() for p in model.parameters()))  # Total parameter count
```

The interview trap: forgetting to call `super().__init__()`. The parent class registers the module, makes parameters discoverable, and sets up the buffers. Without it, `model.parameters()` returns an empty iterator and the model won't train.

### The parameter lifecycle

```
nn.Linear(10, 5) creates a module with:
- self.weight: Parameter of shape (5, 10)
- self.bias: Parameter of shape (5,)

When you do model.to(device), all parameters move.
When you do model.parameters(), you get an iterator over all Parameters.
When you do model.state_dict(), you get a dict of all parameters and buffers.
```

### Parameter initialization

PyTorch's default initialization is decent but rarely optimal. For transformers, careful initialization is important.

```python
class MyModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.linear = nn.Linear(10, 5)
        self._init_weights()

    def _init_weights(self):
        # Linear layers: small normal init
        nn.init.normal_(self.linear.weight, std=0.02)
        if self.linear.bias is not None:
            nn.init.zeros_(self.linear.bias)

    def forward(self, x):
        return self.linear(x)
```

Common initialization schemes:
- **Default for `nn.Linear`**: Kaiming uniform (good for ReLU)
- **For transformers**: Normal with std=0.02 (GPT-2 style)
- **For residual streams**: Scale by `1/sqrt(2*n_layers)` to keep residual magnitudes stable

### The forward method

The `forward` method takes the input and returns the output. PyTorch calls it when you do `model(x)`. It should never be called directly — always use `model(x)` (which goes through hooks and the proper call path).

```python
class MyModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(10, 5)

    def forward(self, x):
        # Add your forward pass logic here
        return self.fc(x)

model = MyModel()
output = model(x)              # Correct — calls forward through __call__
output = model.forward(x)      # Works but bypasses hooks — don't do this
```

### Saving and loading

```python
# Save the full model (less portable)
torch.save(model, 'model.pt')
model = torch.load('model.pt')

# Save just the state dict (preferred — portable)
torch.save(model.state_dict(), 'model.pt')
model = MyModel()
model.load_state_dict(torch.load('model.pt'))
model.eval()                    # Set to eval mode (disables dropout, etc.)
```

The interview trap: forgetting `model.eval()`. Without it, dropout is active during inference, producing noisy predictions. The reverse is also true: forgetting `model.train()` during training disables dropout and other training-specific behaviors.

---

## Training Loop From Scratch

You should be able to write a complete training loop from memory. This is the most common ML coding interview question.

```python
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, TensorDataset

# 1. Data
X = torch.randn(1000, 10)
y = torch.randint(0, 3, (1000,))
dataset = TensorDataset(X, y)
loader = DataLoader(dataset, batch_size=32, shuffle=True)

# 2. Model, loss, optimizer
model = nn.Sequential(nn.Linear(10, 64), nn.ReLU(), nn.Linear(64, 3))
criterion = nn.CrossEntropyLoss()
optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.01)

# 3. Training loop
num_epochs = 10
for epoch in range(num_epochs):
    model.train()                       # Set to training mode
    total_loss = 0

    for batch_x, batch_y in loader:
        # Zero gradients from previous iteration
        optimizer.zero_grad()

        # Forward pass
        logits = model(batch_x)
        loss = criterion(logits, batch_y)

        # Backward pass
        loss.backward()

        # Optional: gradient clipping (common in LM training)
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)

        # Update parameters
        optimizer.step()

        total_loss += loss.item()

    avg_loss = total_loss / len(loader)
    print(f"Epoch {epoch+1}/{num_epochs}, Loss: {avg_loss:.4f}")

# 4. Evaluation
model.eval()
with torch.no_grad():
    test_logits = model(X[:10])
    test_preds = test_logits.argmax(dim=-1)
    test_acc = (test_preds == y[:10]).float().mean()
    print(f"Test accuracy on 10 samples: {test_acc:.2f}")
```

This template covers everything: data loading, model setup, training loop with gradient zeroing, gradient clipping, and evaluation. Memorize it.

### Gradient clipping

For LM training, gradient clipping is essential. Without it, occasional large gradients cause catastrophic parameter updates that destroy the model.

```python
# Norm-based clipping: if total grad norm > max_norm, scale all grads down
torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)

# Value-based clipping: clip each gradient element independently
torch.nn.utils.clip_grad_value_(model.parameters(), clip_value=0.5)
```

Norm-based clipping preserves the direction of the gradient; value-based clipping preserves the relative scale. Norm-based is more common for LM training.

### Learning rate scheduling

The standard pattern: linear warmup then cosine decay. Modern training frameworks make this easy.

```python
from torch.optim.lr_scheduler import LambdaLR
import math

def lr_lambda(step):
    warmup_steps = 1000
    total_steps = 10000
    if step < warmup_steps:
        return step / warmup_steps
    progress = (step - warmup_steps) / (total_steps - warmup_steps)
    return 0.5 * (1 + math.cos(math.pi * progress))

scheduler = LambdaLR(optimizer, lr_lambda)

# In training loop
for step, (x, y) in enumerate(loader):
    # ... forward, backward, step ...
    optimizer.step()
    scheduler.step()        # Update LR
```

Common schedules:
- **Constant**: same LR throughout
- **Warmup + constant**: ramp up, then constant (good for fine-tuning)
- **Warmup + cosine decay**: standard for training from scratch
- **Warmup + linear decay**: simpler alternative to cosine
- **Inverse sqrt**: used in Transformer original paper

### Mixed precision training

Train with FP16/BF16 instead of FP32 to halve memory and speed up on modern GPUs. Use `torch.cuda.amp`.

```python
from torch.cuda.amp import autocast, GradScaler

scaler = GradScaler()

for batch_x, batch_y in loader:
    optimizer.zero_grad()

    # Forward in mixed precision
    with autocast():
        logits = model(batch_x)
        loss = criterion(logits, batch_y)

    # Backward (scaler handles the loss scaling)
    scaler.scale(loss).backward()

    # Unscale before clipping
    scaler.unscale_(optimizer)
    torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)

    # Step
    scaler.step(optimizer)
    scaler.update()
```

For BF16, no scaler is needed (BF16 has the same exponent range as FP32). Just use `with autocast(dtype=torch.bfloat16):`.

---

## Custom Autograd Functions

Sometimes you need to implement a custom operation with a custom backward pass. PyTorch lets you wrap any function with custom gradients.

```python
class CustomReLU(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        # Save tensors needed for backward
        ctx.save_for_backward(x)
        return x.clamp(min=0)

    @staticmethod
    def backward(ctx, grad_output):
        # Receive gradient from downstream
        x, = ctx.saved_tensors
        # ReLU backward: pass through if x > 0, else 0
        grad_input = grad_output.clone()
        grad_input[x < 0] = 0
        return grad_input

# Use it like a regular function
y = CustomReLU.apply(x)
```

The interview question: "Implement the backward pass for a custom operation." The pattern is:
1. `forward` saves what's needed for backward via `ctx.save_for_backward`
2. `backward` receives the upstream gradient and returns the gradient w.r.t. each input
3. Use `.apply()` to call it

The most common use cases: implementing custom kernels, custom loss functions with non-standard gradients, or approximating a non-differentiable operation.

---

## Evaluation Patterns

### The eval loop

```python
model.eval()
total_correct = 0
total_samples = 0
total_loss = 0

with torch.no_grad():
    for batch_x, batch_y in test_loader:
        logits = model(batch_x)
        loss = criterion(logits, batch_y)

        preds = logits.argmax(dim=-1)
        total_correct += (preds == batch_y).sum().item()
        total_samples += batch_y.size(0)
        total_loss += loss.item() * batch_y.size(0)

accuracy = total_correct / total_samples
avg_loss = total_loss / total_samples
print(f"Accuracy: {accuracy:.2%}, Loss: {avg_loss:.4f}")
```

The four essential pieces: `model.eval()` (disables dropout), `torch.no_grad()` (no grad tracking), `argmax` for classification, and the running counters for accuracy.

### Handling variable-length sequences

For NLP, sequences in a batch have different lengths. Two common approaches:

```python
# 1. Pad to max length in batch
def collate_fn(batch):
    # batch is list of (sequence, label)
    sequences, labels = zip(*batch)
    max_len = max(len(s) for s in sequences)
    padded = torch.zeros(len(batch), max_len, dtype=torch.long)
    for i, seq in enumerate(sequences):
        padded[i, :len(seq)] = seq
    return padded, torch.tensor(labels)

# 2. Use torch.nn.utils.rnn.pad_sequence
from torch.nn.utils.rnn import pad_sequence
padded = pad_sequence(sequences, batch_first=True, padding_value=0)
```

Don't forget to use a padding mask in attention so the model ignores pad tokens.

---

## Common Interview Problems

### Problem 1: Implement a custom loss function

```python
class FocalLoss(nn.Module):
    """
    Focal Loss for addressing class imbalance.
    Loss = -alpha * (1-p)^gamma * log(p)
    Down-weights easy examples, focuses on hard ones.
    """
    def __init__(self, alpha=1, gamma=2):
        super().__init__()
        self.alpha = alpha
        self.gamma = gamma

    def forward(self, logits, targets):
        # logits: (B, C), targets: (B,)
        ce = F.cross_entropy(logits, targets, reduction='none')
        pt = torch.exp(-ce)                  # Probability of true class
        focal = self.alpha * (1 - pt) ** self.gamma * ce
        return focal.mean()
```

The interview tests: do you know `F.cross_entropy` accepts logits directly (no need to softmax first), do you know `reduction='none'` gives per-sample loss, and do you understand the focal loss formula.

### Problem 2: Implement learning rate warmup

```python
def get_lr(step, warmup_steps, base_lr, total_steps):
    if step < warmup_steps:
        return base_lr * (step / warmup_steps)
    # Cosine decay
    progress = (step - warmup_steps) / (total_steps - warmup_steps)
    return base_lr * 0.5 * (1 + math.cos(math.pi * progress))

# In training loop
for step, (x, y) in enumerate(loader):
    lr = get_lr(step, warmup_steps=1000, base_lr=1e-3, total_steps=10000)
    for param_group in optimizer.param_groups:
        param_group['lr'] = lr
    # ... rest of training
```

### Problem 3: Implement a custom optimizer (SGD with momentum)

```python
class SGDMomentum:
    def __init__(self, params, lr=0.01, momentum=0.9):
        self.params = list(params)
        self.lr = lr
        self.momentum = momentum
        self.velocities = [torch.zeros_like(p) for p in self.params]

    def step(self):
        for param, velocity in zip(self.params, self.velocities):
            velocity.mul_(self.momentum).add_(param.grad)
            param.data.add_(velocity, alpha=-self.lr)

    def zero_grad(self):
        for param in self.params:
            if param.grad is not None:
                param.grad.zero_()
```

This tests whether you understand the momentum update rule: `v = momentum * v + grad; param -= lr * v`. Adam adds per-parameter adaptive learning rates on top of this.

### Problem 4: Implement a simple VAE encoder

```python
class VAEEncoder(nn.Module):
    def __init__(self, input_dim, hidden_dim, latent_dim):
        super().__init__()
        self.fc1 = nn.Linear(input_dim, hidden_dim)
        self.fc_mu = nn.Linear(hidden_dim, latent_dim)
        self.fc_logvar = nn.Linear(hidden_dim, latent_dim)

    def forward(self, x):
        h = F.relu(self.fc1(x))
        mu = self.fc_mu(h)
        logvar = self.fc_logvar(h)
        # Reparameterization trick: z = mu + std * eps
        std = torch.exp(0.5 * logvar)
        eps = torch.randn_like(std)
        z = mu + std * eps
        return z, mu, logvar
```

The reparameterization trick is the key insight: sampling `z ~ N(mu, var)` is differentiable w.r.t. `mu` and `var` if you express it as `z = mu + std * eps` where `eps ~ N(0, 1)`. Without this, gradients can't flow through the sampling step.

---

## Performance and Profiling

### Moving to GPU

```python
# Move model to GPU
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
model = model.to(device)

# Move tensors to GPU
x = x.to(device)
y = y.to(device)

# Verify everything is on the same device
assert x.device == next(model.parameters()).device
```

The common bug: forgetting to move either the model or the data to the same device. The error is `RuntimeError: Expected all tensors to be on the same device`.

### DataLoader performance

```python
from torch.utils.data import DataLoader

loader = DataLoader(
    dataset,
    batch_size=32,
    shuffle=True,
    num_workers=4,            # Parallel data loading
    pin_memory=True,          # Faster GPU transfer
    prefetch_factor=2,        # Prefetch 2 batches per worker
    persistent_workers=True,  # Keep workers alive across epochs
)
```

`num_workers=0` (default) means data loading happens in the main process, blocking training. `num_workers=4-8` is usually optimal. `pin_memory=True` enables faster CPU-to-GPU transfer.

### Profiling

```python
from torch.profiler import profile, ProfilerActivity

with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA]) as prof:
    for batch in loader:
        output = model(batch)
        loss = criterion(output, target)
        loss.backward()
        optimizer.step()

print(prof.key_averages().table(sort_by="cuda_time_total", row_limit=10))
```

This shows where time is being spent: data loading, forward pass, backward pass, optimizer step, or GPU synchronization.

---

## Common Pitfalls

### 1. Cross-entropy expects raw logits

```python
# WRONG: double softmax
logits = model(x)
probs = F.softmax(logits, dim=-1)
loss = F.cross_entropy(probs, targets)  # Wrong! probs are not logits

# CORRECT
logits = model(x)
loss = F.cross_entropy(logits, targets)  # Applies softmax internally
```

`F.cross_entropy` and `nn.CrossEntropyLoss` expect raw logits and apply softmax internally. Applying softmax first and then calling cross-entropy is wrong.

### 2. Softmax dim

```python
# WRONG: softmax over wrong dim
x = torch.randn(2, 5)
F.softmax(x, dim=0)          # Softmax over batch dim (probably not what you want)

# CORRECT: softmax over feature dim
F.softmax(x, dim=1)          # Softmax over the 5-class dim
```

`dim=-1` is the most common (and safest) choice because it works regardless of input shape.

### 3. Reduction default

```python
# Default: returns mean
loss = F.cross_entropy(logits, targets)  # Scalar (mean over batch)

# Per-sample: useful when you want to weight or filter
loss_per_sample = F.cross_entropy(logits, targets, reduction='none')  # (B,)

# Sum: sometimes used for accumulation
loss = F.cross_entropy(logits, targets, reduction='sum')
```

### 4. In-place operations

```python
# WRONG: in-place relu can break autograd
x = F.relu(x, inplace=True)  # x might be needed for backward

# Usually fine: nn.ReLU has inplace param
self.relu = nn.ReLU(inplace=True)
```

In-place ops save memory but can break autograd if the modified tensor is needed for the backward pass. Use with caution.

### 5. View vs reshape

```python
x = torch.randn(2, 3, 4)
y = x.permute(2, 0, 1)       # Not contiguous
y.view(8, 3)                # ERROR: not contiguous
y.reshape(8, 3)             # Works: makes a copy if needed
y.contiguous().view(8, 3)   # Works: explicit copy
```

If you've done `permute` or `transpose`, the tensor is not contiguous and `.view()` will fail. Use `.reshape()` or `.contiguous().view()`.

---

## Interview Checklist

Before submitting any PyTorch solution, verify:

- [ ] Model is on the correct device (`model.to(device)`)
- [ ] Data is on the same device
- [ ] `optimizer.zero_grad()` called before backward
- [ ] `model.train()` for training, `model.eval()` for evaluation
- [ ] `torch.no_grad()` context for inference
- [ ] Correct loss: `F.cross_entropy` expects raw logits, not probabilities
- [ ] Correct softmax dim: usually `dim=-1` or `dim=1`
- [ ] Gradient clipping for LMs (max_norm=1.0 typical)
- [ ] Memory cleanup: `del` intermediate tensors, `torch.cuda.empty_cache()` if needed
- [ ] Mixed precision where appropriate
- [ ] DataLoader with `num_workers > 0` for training speed

The next doc, *ML Coding - Transformer*, builds on these foundations to implement the transformer architecture from scratch — the most common ML coding interview question.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- Tensors = multi-dimensional arrays, the foundation of all PyTorch operations.
- Autograd = automatic differentiation, tracks operations for backprop.
- nn.Module = base class for all models, defines forward().
- Training loop: forward → loss → backward → step → zero_grad.
- Device management: .to(device) for GPU/CPU. Always use torch.no_grad() for inference.

**Common Follow-Up Questions:**
- "How does autograd work?" — PyTorch builds a computational graph during forward pass. Each tensor tracks its operations. backward() traverses the graph in reverse, computing gradients via chain rule.
- "What's the difference between tensor.view() and tensor.reshape()?" — view() requires contiguous memory, reshape() doesn't (may copy). Use reshape() when unsure.

**Gotcha:** Forgetting to call optimizer.zero_grad() before backward(). Without this, gradients accumulate across iterations (PyTorch sums gradients by default), causing incorrect updates and training instability.
