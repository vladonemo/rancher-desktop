/*
Copyright © 2022 SUSE LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package cmd

import (
	"fmt"
	"github.com/spf13/cobra"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

// shellCmd represents the shell command
var shellCmd = &cobra.Command{
	Use:   "shell",
	Short: "Run an interactive shell or a command in a Rancher Desktop-managed VM",
	Long: `Run an interactive shell or a command in a Rancher Desktop-managed VM. For example:

> rdctl shell
-- Runs an interactive shell
> rdctl shell echo "An embedded ; ls thing"
-- Echoes back "An embedded ; ls thing".`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return doShellCommand(cmd, args)
	},
}

var initialWindowsShellDirectory string

func init() {
	rootCmd.AddCommand(shellCmd)
	if runtime.GOOS == "windows" {
		startCmd.Flags().StringVar(&initialWindowsShellDirectory, "cd", "", "Directory to run command in.")
	}
}

func doShellCommand(cmd *cobra.Command, args []string) error {
	fmt.Fprintf(os.Stderr, "QQQ: args: %v\n", args)
	var commandName string
	if runtime.GOOS == "windows" {
		commandName = "wsl"
		if initialWindowsShellDirectory != "" {
			args = append([]string{"--cd", initialWindowsShellDirectory}, args...)
		}
	} else {
		err := addLimaBinToPath()
		if err != nil {
			return err
		}
		err = setupLimaHome()
		if err != nil {
			return err
		}
		commandName = "limactl"
		args = append([]string{"shell", "0"}, args...)
	}
	fmt.Fprintf(os.Stderr, "QQQ: LIMA_HOME: %s\n", os.Getenv("LIMA_HOME"))
	blip, err := exec.LookPath("limactl")
	if err != nil {
		fmt.Fprintf(os.Stderr, "QQQ: Can't find limactl: %s\n", err)
	} else {
		fmt.Fprintf(os.Stderr, "QQQ: limactl is at %s\n", blip)
	}
	fmt.Fprintf(os.Stderr, "QQQ: about to launch %s %s\n", commandName, strings.Join(args, " "))
	shellCommand := exec.Command(commandName, args...)
	shellCommand.Stdin = os.Stdin
	shellCommand.Stdout = os.Stdout
	shellCommand.Stderr = os.Stderr
	return shellCommand.Run()
}

func addLimaBinToPath() error {
	_, err := exec.LookPath("limactl")
	if err == nil {
		// It's already in the pth
		return err
	}
	execPath, err := os.Executable()
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "QQQ: os.Executable: %s\n", execPath)
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "QQQ: os.Executable resolved symlink: %s\n", execPath)
	candidatePath := path.Join(path.Dir(path.Dir(execPath)), "lima", "bin")
	notFoundError := fmt.Errorf("no executable limactl file found in %s; try rerunning with the directory containing `limactl` added to PATH", candidatePath)
	fmt.Fprintf(os.Stderr, "QQQ: Looking for limabin: candidatePath:%s\n", candidatePath)
	stat, err := os.Stat(path.Join(candidatePath, "limactl"))
	if err != nil {
		return notFoundError
	}
	if uint32(stat.Mode().Perm())&0111 == 0 {
		return notFoundError
	}
	os.Setenv("PATH", fmt.Sprintf("%s:%s", candidatePath, os.Getenv("PATH")))
	return nil
}

func setupLimaHome() error {
	if os.Getenv("LIMA_HOME") != "" {
		// It's already in the environment
		return nil
	}
	var candidatePath string
	if runtime.GOOS == "linux" {
		candidatePath = path.Join(os.Getenv("HOME"), ".local", "share", "rancher-desktop", "lima")
	} else {
		candidatePath = path.Join(os.Getenv("HOME"), "Library", "Application Support", "rancher-desktop", "lima")
	}
	stat, err := os.Stat(candidatePath)
	const suggestionMessage = "try rerunning with the environment variable LIMA_HOME set to such a directory"
	if err != nil {
		return fmt.Errorf("can't find the lima-home directory in the expected spot; %s", suggestionMessage)
	}
	if !stat.Mode().IsDir() {
		return fmt.Errorf("path %s exists but isn't a directory; %s", candidatePath, suggestionMessage)
	}
	os.Setenv("LIMA_HOME", candidatePath)
	return nil
}
